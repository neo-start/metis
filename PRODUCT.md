# Metis

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Neo uses local Codex and Claude Code across existing projects, and wants the capabilities of both T3 Code and Synara in one workspace. Development is authorized in `~/Stars`.

## Product Purpose

Manage projects, conversations, execution and deliverables from a unified desktop workspace, with browser and phone continuation in the full scope.

## Operating Context

A local development fork of Synara, retaining its Electron, React, Effect server and provider adapters. The user selected the name Metis on 2026-09-23. Preserve the upstream MIT license and attribution. This is separate from Dagent and Fleet.

## Capabilities and Constraints

- Retain native Agent integrations, permissions, history import, handoff, workspace tools, automations and Studio.
- Connect the overview to real project/thread/provider state; no fabricated tasks or success states.
- Isolate application data and ports. Preserve original CLI configuration and authentication.
- Use the existing project directory unless the user selects a worktree.
- Handoff transfers a bounded recap and working state, not hidden native context.
- No frontend tests or browser QA unless explicitly requested, per standing user instruction. Type checks, lint and builds are allowed.
- Remote publishing, commercial distribution and a native phone app remain future work.

## Product Principles

- Execution state comes from the server.
- Make everyday tasks direct and advanced tools available on demand.
- Retain the combined product scope while delivering usable increments.
- Distinguish inherited capabilities from newly implemented features.

## Evidence on Hand

The user approved the combined scope and authorized development. Research and scope are in docs/workbench. Existing source styles and components are the visual authority for this extension. The user's approval of the preceding scope supplies the product brief; the product name is confirmed, while distribution choices remain provisional.
