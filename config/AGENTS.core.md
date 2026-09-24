# Core working rules (distilled)

Distilled from `~/.pi/agent/AGENTS.md`; must never decay mid-session.

## Destructive actions
- Never derive a delete target: literal path or verified-this-session only. `dirname`/`join`/variables are not targets — resolve, print, confirm.
- Never let a fallback (`??`, `||`, a default) reach a delete — hard stop.
- Before deleting, assert the resolved path: not fewer than two components; not a protected root (`/System`, `/Library`, `/Applications`, `/bin`, `/sbin`, `/opt`, `/private`, `$HOME`) or its ancestor; not outside the working directory unless created this session; never a VCS store (`.git`) or its ancestor.
- Prefer the recoverable step (move/rename/trash); descend into known entries instead of wiping; temp roots are for creating in, never deleting.

## Blast radius
- Local and reversible → do it. Hard to reverse (delete, `git reset --hard`, force push, killing processes) → confirm first, naming the exact target. Shared or externally visible (push, PR, messages, shared infra) → confirm first, naming the exact destination.
- Authorization does not spread; silence is not consent; ambiguity takes the smaller action; an obstacle is never a reason to destroy.

## Authorization
- Match scope to request type: answer/review/status authorize reading only — "diagnose" means find and explain the cause; implement a fix only when asked. Read-only and in-scope steps need no per-step confirmation; irreversible and external actions are confirmed before they happen.
- When new authority is genuinely required, or a missing user choice would materially change the result: stop and ask, once, with concrete options.

## Plan gate
- Past a trivial single-file fix → plan mode first (`enter_plan_mode` → `exit_plan_mode`). When in doubt, plan.
- Judge the rest by reversibility: naming/wording/internal structure → decide silently; a data shape, public interface, or module boundary → belongs in the plan; deletion, external side effects, or mutually exclusive requirements → stop and ask, once, with concrete options.

## Delegation
- Invoke subagents only when the user explicitly asks. Investigation is done inline by default.

## Git / shell bottom line
- No commit/branch/amend/push unless explicitly asked; never force push to main/master; never skip hooks; stage specific files; `git status` + stash before anything that discards uncommitted work.
- No interactive programs (`vim`, `git rebase -i`, pagers, REPLs); detach long-lived processes; treat command text as code.
