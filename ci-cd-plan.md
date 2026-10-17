# CI/CD Plan

How to take this service from a push on GitHub to a running server, on AWS EC2
or on GCP, using GitHub Actions.

Status: this is a plan. The `ci` workflow in `.github/workflows/ci.yml` exists
and covers the continuous integration half. The deploy workflows below are
written out so they can be dropped in, but they have not been run against a real
AWS or GCP account, so expect to adjust names, regions and IDs.

## 1. The one thing to know before deploying

State lives in memory (see `DECISIONS.md`). That has two consequences for any
server:

- **Run exactly one instance.** Stock, coupons and idempotency are protected by
  code that only works inside one Node process. Two instances behind a load
  balancer would each have their own stock and could oversell.
- **Every deploy and every restart wipes all carts, orders and coupons.**

So the pipelines here deploy a single instance and say so where it matters.
Scaling out comes after the database move described in section 11.

## 2. The pipeline at a glance

```
pull request          push to main                       release
     |                     |                                |
     v                     v                                v
  ci workflow  ----->  ci workflow  --success-->  build image (tag = commit SHA)
  typecheck            same checks                          |
  tests                                                     v
  build                                          deploy to STAGING (automatic)
  load test                                                 |
  docker build                                              v
                                                     smoke test staging
                                                            |
                                                            v
                                               manual approval (GitHub Environment)
                                                            |
                                                            v
                                                   deploy to PRODUCTION
                                                            |
                                                            v
                                              health check, auto rollback on failure
```

Rules that keep it safe:

- Nothing deploys unless `ci` passed on that exact commit.
- The image is built once and the same image is promoted from staging to
  production. It is never rebuilt for production.
- Images are tagged with the commit SHA, never only `latest`, so any past
  version can be redeployed.
- Production waits for a human click.

## 3. What already exists

`.github/workflows/ci.yml`, named `ci`, runs on pushes to `main` and on pull
requests:

| Job | What it does |
| --- | --- |
| `test` | `npm ci`, typecheck, the vitest suite, `npm run build` |
| `load` | Builds, starts the service with a 40 ms payment delay, runs `loadtest/hammer.py` |
| `image` | Builds the Docker image and smoke tests `/health` and `/products` |

The `Dockerfile` is a two stage Node 22 Alpine build that runs as the non-root
`node` user, listens on port 3000, sets `NODE_ENV=production`, and has a
`HEALTHCHECK` on `/health`.

Because the deploy workflows below listen for the `ci` workflow finishing, none
of this needs to change.

## 4. Setup common to both clouds

### Branch protection

In the repository settings, protect `main`:

- Require a pull request before merging.
- Require the status checks `test`, `load` and `image` to pass.
- Block force pushes.

### GitHub Environments

Create two environments under Settings, Environments: `staging` and
`production`.

- `production`: add required reviewers (you), so the deploy job pauses for
  approval. This is available on public repositories, and on private ones with a
  paid plan.
- Put environment specific values in each environment, not in the repository.
  The same secret name (for example `AWS_ROLE_ARN`) can then hold a different
  value per environment.

### Variables and secrets

| Name | Kind | Example |
| --- | --- | --- |
| `AWS_REGION` or `GCP_REGION` | variable | `ap-south-1`, `asia-south1` |
| `AWS_ROLE_ARN` | secret | role the workflow assumes |
| `EC2_INSTANCE_ID` | variable | `i-0abc123...` |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | secret | `projects/123/locations/global/...` |
| `GCP_SERVICE_ACCOUNT` | secret | `deployer@project.iam.gserviceaccount.com` |
| `APP_URL` | variable | `https://staging.example.com` |

Application settings (these are not secrets, there are none in this service):

```
NODE_ENV=production
PORT=3000
COUPON_EVERY_N=5
COUPON_DISCOUNT_PERCENT=10
PAYMENT_SIMULATION=off
```

`NODE_ENV=production` already turns off the `X-Simulate-Payment` header.

### No long lived cloud keys

Use OIDC so GitHub proves its identity to the cloud for each run, and no access
key is ever stored in the repository. Both clouds below are set up that way.
Pin third party actions to a full commit SHA once the pipeline is stable.

### Where images live

Pick one registry per cloud:

- AWS: Amazon ECR.
- GCP: Artifact Registry.
- Either: GitHub Container Registry (`ghcr.io`), which needs no cloud setup but
  the server must be able to pull from it (a read only token for private images).

The examples use ECR and Artifact Registry, since the server then authenticates
with its own cloud identity.

## 5. Option A: AWS EC2

### One time server setup

1. Launch an instance (Amazon Linux 2023 or Ubuntu). A small size is enough.
2. Security group: allow 80 and 443 from anywhere. Do **not** open 22. Use AWS
   Systems Manager (SSM) instead of SSH, so there is no key to leak and no open
   port to attack. If you prefer SSH, restrict port 22 to your own IP.
3. Instance profile (IAM role attached to the instance) with:
   - `AmazonSSMManagedInstanceCore`, so SSM can run commands on it.
   - Read access to the ECR repository (`AmazonEC2ContainerRegistryReadOnly`).
4. Install Docker and the AWS CLI, and enable Docker at boot:
   ```bash
   sudo dnf install -y docker && sudo systemctl enable --now docker
   ```
5. Put the app settings in `/etc/uniblox.env`, one `KEY=value` per line.
6. Put a TLS terminating proxy in front, on the same machine. Caddy is the
   shortest route since it fetches certificates by itself:
   ```
   your-domain.example {
       reverse_proxy 127.0.0.1:3000
   }
   ```
   (An Application Load Balancer also works, but with one instance it adds cost
   for little gain.)
7. Create an ECR repository named `uniblox`.

### The deploy script on the server

Save as `/opt/uniblox/deploy.sh`, `chmod +x`. It pulls first (so downtime is
only the container swap), starts the new image, waits for `/health`, and rolls
back to the previous image if the new one does not come up.

```bash
#!/usr/bin/env bash
set -euo pipefail

IMAGE="$1"
NAME=uniblox
REGION="${AWS_REGION:-ap-south-1}"

PREVIOUS="$(docker inspect -f '{{.Config.Image}}' "$NAME" 2>/dev/null || true)"

aws ecr get-login-password --region "$REGION" \
  | docker login --username AWS --password-stdin "${IMAGE%%/*}"
docker pull "$IMAGE"

start() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --restart unless-stopped \
    -p 127.0.0.1:3000:3000 --env-file /etc/uniblox.env "$1" >/dev/null
}

healthy() {
  for _ in $(seq 1 30); do
    curl -sf http://127.0.0.1:3000/health >/dev/null && return 0
    sleep 1
  done
  return 1
}

start "$IMAGE"
if healthy; then
  echo "deployed $IMAGE"
  docker image prune -f >/dev/null
  exit 0
fi

echo "new version did not become healthy" >&2
if [ -n "$PREVIOUS" ]; then
  echo "rolling back to $PREVIOUS" >&2
  start "$PREVIOUS"
fi
exit 1
```

### AWS side of OIDC (once)

1. IAM, Identity providers, add `token.actions.githubusercontent.com` with
   audience `sts.amazonaws.com`.
2. Create a role the workflow can assume, with this trust policy (swap in your
   account id):
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com" },
       "Action": "sts:AssumeRoleWithWebIdentity",
       "Condition": {
         "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
         "StringLike": { "token.actions.githubusercontent.com:sub": [
           "repo:vikranth-krishna/Uniblox:environment:*",
           "repo:vikranth-krishna/Uniblox:ref:refs/heads/main"
         ] }
       }
     }]
   }
   ```
   Two subjects are needed because GitHub puts a different identity in the
   token depending on the job. Jobs that declare an `environment` (staging,
   production) present `environment:<name>`, and the `build` job, which has no
   environment, presents `ref:refs/heads/main`. With only the first pattern, the
   build job would be refused.
3. Give that role only what the job needs: push to the one ECR repository, and
   `ssm:SendCommand` and `ssm:GetCommandInvocation` on the one instance.

### Workflow: `.github/workflows/deploy-ec2.yml`

```yaml
name: deploy-ec2

on:
  workflow_run:
    workflows: [ci]
    types: [completed]
    branches: [main]
  workflow_dispatch:
    inputs:
      image_tag:
        description: Commit SHA to deploy (use this to roll back)
        required: false

permissions:
  id-token: write
  contents: read

concurrency:
  group: deploy-ec2
  cancel-in-progress: false

jobs:
  build:
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    outputs:
      image: ${{ steps.meta.outputs.image }}
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha || github.sha }}
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2
      - id: meta
        run: |
          TAG="${{ inputs.image_tag || github.event.workflow_run.head_sha || github.sha }}"
          echo "image=${{ steps.ecr.outputs.registry }}/uniblox:${TAG}" >> "$GITHUB_OUTPUT"
      - name: Build and push (skipped when redeploying an existing tag)
        if: ${{ !inputs.image_tag }}
        run: |
          docker build -t "${{ steps.meta.outputs.image }}" .
          docker push "${{ steps.meta.outputs.image }}"

  staging:
    needs: build
    runs-on: ubuntu-latest
    environment: staging
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
      - name: Deploy through SSM
        run: |
          ID=$(aws ssm send-command \
            --instance-ids "${{ vars.EC2_INSTANCE_ID }}" \
            --document-name AWS-RunShellScript \
            --parameters 'commands=["AWS_REGION=${{ vars.AWS_REGION }} /opt/uniblox/deploy.sh ${{ needs.build.outputs.image }}"]' \
            --query Command.CommandId --output text)
          aws ssm wait command-executed --command-id "$ID" --instance-id "${{ vars.EC2_INSTANCE_ID }}"
      - name: Smoke test
        run: |
          curl -sf "${{ vars.APP_URL }}/health"
          curl -sf "${{ vars.APP_URL }}/products" > /dev/null

  production:
    needs: [build, staging]
    runs-on: ubuntu-latest
    environment: production   # pauses here until a reviewer approves
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
      - name: Deploy through SSM
        run: |
          ID=$(aws ssm send-command \
            --instance-ids "${{ vars.EC2_INSTANCE_ID }}" \
            --document-name AWS-RunShellScript \
            --parameters 'commands=["AWS_REGION=${{ vars.AWS_REGION }} /opt/uniblox/deploy.sh ${{ needs.build.outputs.image }}"]' \
            --query Command.CommandId --output text)
          aws ssm wait command-executed --command-id "$ID" --instance-id "${{ vars.EC2_INSTANCE_ID }}"
      - name: Verify
        run: curl -sf "${{ vars.APP_URL }}/health"
```

Notes:

- `staging` and `production` each use their own environment, so each resolves
  its own `AWS_ROLE_ARN`, `EC2_INSTANCE_ID` and `APP_URL`. With one server you
  can start with just `production`, and add `staging` when there is a second
  machine.
- `aws ssm wait command-executed` fails the job when the script exits non zero,
  which includes the rollback case in `deploy.sh`.
- Using SSH instead: replace the SSM step with an `ssh` call, store a deploy key
  in the environment secrets, and add the host key to `known_hosts`. SSM is
  preferred because there is no inbound port and no key.

## 6. Option B: GCP

Two routes. Cloud Run is the easiest to run. A Compute Engine VM is the closest
match to the EC2 setup above.

### GCP side of OIDC (once, both routes)

Use Workload Identity Federation so GitHub can act as a service account without
a downloaded key:

```bash
gcloud iam workload-identity-pools create github --location=global
gcloud iam workload-identity-pools providers create-oidc github-provider \
  --location=global --workload-identity-pool=github \
  --issuer-uri=https://token.actions.githubusercontent.com \
  --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository" \
  --attribute-condition="assertion.repository=='vikranth-krishna/Uniblox'"

gcloud iam service-accounts create deployer
gcloud iam service-accounts add-iam-policy-binding \
  deployer@PROJECT_ID.iam.gserviceaccount.com \
  --role=roles/iam.workloadIdentityUser \
  --member="principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository/vikranth-krishna/Uniblox"
```

Give the `deployer` service account only: `roles/artifactregistry.writer` on the
repository, plus `roles/run.admin` and `roles/iam.serviceAccountUser` for Cloud
Run, or `roles/compute.instanceAdmin.v1` and IAP tunnel access for the VM.

Create the Artifact Registry repository once:

```bash
gcloud artifacts repositories create uniblox --repository-format=docker --location=REGION
```

### Route 1: Cloud Run

Cloud Run scales to zero and scales out by default. This service cannot scale
out (section 1), so the workflow pins it to a single instance. Because Cloud Run
may still replace the instance, data can disappear at any time. That is fine for
a demo and not for real orders.

`.github/workflows/deploy-cloudrun.yml`:

```yaml
name: deploy-cloudrun

on:
  workflow_run:
    workflows: [ci]
    types: [completed]
    branches: [main]
  workflow_dispatch:

permissions:
  id-token: write
  contents: read

concurrency:
  group: deploy-cloudrun
  cancel-in-progress: false

env:
  REGION: ${{ vars.GCP_REGION }}
  IMAGE: ${{ vars.GCP_REGION }}-docker.pkg.dev/${{ vars.GCP_PROJECT }}/uniblox/uniblox

jobs:
  deploy:
    if: github.event_name == 'workflow_dispatch' || github.event.workflow_run.conclusion == 'success'
    runs-on: ubuntu-latest
    environment: production
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${{ github.event.workflow_run.head_sha || github.sha }}
      - id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: ${{ secrets.GCP_WORKLOAD_IDENTITY_PROVIDER }}
          service_account: ${{ secrets.GCP_SERVICE_ACCOUNT }}
      - uses: google-github-actions/setup-gcloud@v2
      - run: gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
      - name: Build and push
        run: |
          SHA="${{ github.event.workflow_run.head_sha || github.sha }}"
          docker build -t "$IMAGE:$SHA" .
          docker push "$IMAGE:$SHA"
      - id: deploy
        uses: google-github-actions/deploy-cloudrun@v2
        with:
          service: uniblox
          region: ${{ env.REGION }}
          image: ${{ env.IMAGE }}:${{ github.event.workflow_run.head_sha || github.sha }}
          env_vars: |
            NODE_ENV=production
            COUPON_EVERY_N=5
            COUPON_DISCOUNT_PERCENT=10
            PAYMENT_SIMULATION=off
          flags: --port=3000 --min-instances=1 --max-instances=1 --allow-unauthenticated
      - name: Smoke test
        run: curl -sf "${{ steps.deploy.outputs.url }}/health"
```

`--min-instances=1` keeps one instance warm so state is not dropped just for
being idle. Cloud Run keeps the previous revision, so a bad release is reversed
by moving traffic back (section 9).

### Route 2: Compute Engine VM

Same shape as EC2: a VM running Docker, the same `deploy.sh` with the registry
login swapped, Caddy in front. Reach the VM through IAP tunnelling, which needs
no public SSH port.

Registry login line in `deploy.sh` for GCP, replacing the `aws ecr` line:

```bash
gcloud auth configure-docker "${IMAGE%%/*}" --quiet
```

Workflow steps after the `auth` and `setup-gcloud` steps from the Cloud Run
workflow:

```yaml
      - name: Deploy to the VM
        run: |
          gcloud compute ssh uniblox-vm \
            --zone "${{ vars.GCP_ZONE }}" --tunnel-through-iap \
            --command "sudo /opt/uniblox/deploy.sh $IMAGE:${{ github.event.workflow_run.head_sha || github.sha }}"
```

The VM's service account needs `roles/artifactregistry.reader`. Open only
80 and 443 in the firewall.

## 7. Verifying a release

`/health` proves the process is up. To prove the rules still hold, run the
Python check against **staging only**, right after a deploy so the state is
fresh:

```yaml
      - name: Invariant check against staging
        run: python3 loadtest/hammer.py --base "${{ vars.APP_URL }}" --every-n 5
```

It creates carts, orders and coupons, so never point it at production. The
server needs `COUPON_EVERY_N=5` for the numbers to line up. A 40 ms payment
delay (`PAYMENT_DELAY_MS=40`) on staging makes the races meaningful, and should
be absent in production.

## 8. Safety rules

- `concurrency` groups, as in the examples, so two deploys never overlap.
  `cancel-in-progress: false` lets a running deploy finish.
- Least privilege on every cloud role, scoped to this repository, this
  registry and this one server.
- Trust policies bound to this repository (and to environments on AWS), so a
  fork or another repo cannot assume the role.
- Never print secrets. GitHub masks them, but do not echo derived values.
- Scan the image in CI before it is pushed, for example Trivy:
  `aquasecurity/trivy-action` with `exit-code: 1` and `severity: HIGH,CRITICAL`.
- Turn on Dependabot for npm, GitHub Actions and the Dockerfile base image.
- Keep the container non root (already done) and bind the app to
  `127.0.0.1` behind the proxy (done in `deploy.sh`).

## 9. Rollback

Pick the fastest one for the situation:

1. **Automatic**: on EC2 and the VM, `deploy.sh` restores the previous image if
   the new one is not healthy within 30 seconds.
2. **Redeploy an old version**: run the `deploy-ec2` workflow by hand
   (`workflow_dispatch`) and give it an earlier commit SHA as `image_tag`. It
   skips the build and deploys that image.
3. **Cloud Run**: move traffic to the last good revision, no rebuild:
   ```bash
   gcloud run revisions list --service uniblox --region REGION
   gcloud run services update-traffic uniblox --region REGION --to-revisions REVISION=100
   ```
4. **Revert in git**: revert the commit on `main`, and the pipeline ships the
   revert like any other change.

Because state is in memory, a rollback also resets data, the same as any deploy.

## 10. Watching it in production

The service already has the hooks:

- `GET /health` for load balancer and uptime checks.
- `GET /metrics` in Prometheus text format (request counts by route and status,
  checkout outcomes, API errors by code).
- One JSON object per log line on stdout, with a request id.

To collect them:

- **AWS**: run the container with the `awslogs` logging driver so stdout goes to
  CloudWatch Logs, and add a CloudWatch alarm on a metric filter for
  `"level":"error"`. Scrape `/metrics` with the CloudWatch agent or a small
  Prometheus.
- **GCP**: Cloud Run and the Ops Agent on a VM send stdout to Cloud Logging
  automatically. Use Managed Service for Prometheus or the Ops Agent to read
  `/metrics`.

Alerts worth having: health check failing, 5xx rate above a threshold,
`PAYMENT_DECLINED` rate jumping, deploy job failures.

## 11. When it needs to scale or hold real data

None of the above is production grade for real customers until state moves out
of memory. The order of work:

1. Add a database (Postgres) behind the existing store, with the conditional
   updates and unique constraints described in `DECISIONS.md`. Run the same
   concurrency tests against it in CI using a Postgres service container.
2. Add a migration step to the pipeline that runs before the new version
   starts, written as expand then contract so the old and new code can both run
   against the schema during a rollout.
3. Only then run several instances: an Application Load Balancer with an Auto
   Scaling group on AWS, or Cloud Run with a higher `--max-instances` on GCP.
   Use rolling or blue green deploys so there is no gap.
4. Add reservation expiry, so a crash between reserve and commit cannot leave
   stock held forever.
5. Add authentication on `/admin` and rate limiting at the proxy.

## 12. Suggested order to build this

1. Branch protection and the two GitHub Environments.
2. Registry and OIDC role (AWS or GCP), and prove it with a workflow that only
   runs `aws sts get-caller-identity` or `gcloud auth list`.
3. Server or Cloud Run service, deployed once by hand.
4. Add the deploy workflow for staging only, and confirm `/health` from the
   workflow.
5. Add production behind the approval gate.
6. Add the staging invariant check, image scanning and alerts.
7. Rehearse a rollback before it is needed.
