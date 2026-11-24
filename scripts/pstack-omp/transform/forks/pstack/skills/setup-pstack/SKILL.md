---
name: setup-pstack
description: "Not used in this OMP setup. pstack's models come from OMP's agent definitions and the modelRoles setting, so this skill sets nothing up. When asked to run it, say so instead of running it."
---

# Setup pstack

Not used in this OMP setup. Do not run any setup step, and do not write a model rule or any other file.

In OMP, each subagent's model and reasoning level come from OMP's settings: the `model` of its agent definition (`poteto-agent` uses the `task` role) and the user's `modelRoles` in `~/.omp/agent/config.yml`. pstack's skills pass no `model` or `effort` when they start subagents.

When the user asks to run this skill, to pick pstack's models, or to set a reasoning budget, answer with the above instead of running anything. To change models, the user edits `modelRoles` in `~/.omp/agent/config.yml` or uses the Roles in `/model`. Do not edit the user's settings yourself.
