---
name: cluster-workers
version: "2.1"
last_updated: 2026-09-14
id: cluster-workers
one_line_purpose: Scale OMP contributor workers across Kubernetes clusters.
entry_point: docs/skills/cluster-workers.md
category: ci-ops
status: active
tags: [kubernetes, cluster, scale, workers]
description: "Manages OMP contributor workers in bluefin-system and secret synchronization."
metadata:
  type: procedure
  context7-sources: [/websites/kubernetes_io, /websites/podman_io_en]
---

# Cluster Workers

> Review scales unattended contributor workers across an active Kubernetes
> cluster, donating multi-node inference without draining local resources.

## When to Use

Load this when scaling cluster contributors, modifying `deploy/contribute.yaml`,
or configuring `contribute-secret`.

## When Not to Use

Do not load this for local single-container runs (`launcher.md`) or review
dashboard navigation (`review-dashboard.md`).

## Core Commands

```bash
just contribute cluster 3            # scale 3 cluster workers
just review-stop cluster            # scale workers to 0
just review-doctor                  # check cluster deployment health
```

## Architecture & Lifecycle

1. **Namespace & Secret Sync:** `scale_contribute` ensures `bluefin-system`
   exists and synchronizes `contribute-secret`. The deployment exposes the
   selected Copilot, Anthropic, OpenAI, or Gemini credential to OMP through
   optional secret-backed environment variables.
2. **Plaintext Protection:** Token values enter `kubectl create secret`
   via process substitution file descriptors (`--from-file=KEY=<(...)`), preventing exposure in `ps` argv.
   Server-side apply is used and legacy annotations are stripped.
3. **Hive Hub Consistency:** The launcher validates `HIVE_HUB` before mutation,
   preventing split-brain connections between local and cluster workers.
4. **Independent Task Streams:** Each pod establishes its own WebSocket to Hive
   and processes assignments independently.
5. **Non-Blocking Rollout:** Rollout observation waits 15 seconds. If image
   pulls take longer, a warning is printed and the launcher continues.
6. **Teardown:** Cluster workers continue running independently of the OMP
   maintainer workbench. Stop them explicitly with `just review-stop cluster`.


## Common Rationalizations

| Rationalization | Reality |
|---|---|
| "Pass tokens via --from-literal." | Command-line arguments are visible in `/proc` and `ps`. Feed tokens via process substitution file descriptors. |
| "Abort if cluster is offline." | The OMP workbench owns no cluster dependency; contributor scale-out reports its own failure. |

## Red Flags

- Hardcoding `HIVE_HUB` in deployment manifests.
- Leaking credentials in `kubectl.kubernetes.io/last-applied-configuration`.
- Halting maintainer review triage because of cluster connection timeouts.

`review-container cluster [N]` delegates to the same `contribute` deployment.

## Verification

```bash
kubectl get deployment contribute -n bluefin-system
kubectl get pods -n bluefin-system -l app.kubernetes.io/name=contribute
just review-doctor
```
