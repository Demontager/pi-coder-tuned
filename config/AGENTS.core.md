# Core working rules (distilled)

Distilled from `~/.pi/agent/AGENTS.md`; must never decay mid-session.

## Destructive actions
- Never derive a delete target: literal path or verified-this-session only. `dirname`/`join`/variables are not targets — resolve, print, confirm.
- Never let a fallback (`??`, `||`, a default) reach a delete — hard stop.
- Before deleting, assert the resolved path: ≥2 components; not a protected root (a system directory, `$HOME`/`~`, a volume/mount root, or a repo root where `.git` lives) or its ancestor — the kernel enforces the full catalog; not outside the working directory unless created this session; never a VCS store (`.git`) or its ancestor.
- Prefer the recoverable step (move/rename/trash); descend into known entries instead of wiping; temp roots are for creating in, never deleting.
- Delete by literal path, not from a generated script; if a script must delete, print every resolved target first and delete in a later pass. Never shadow `HOME`/`PWD`/`TMPDIR`/`USER`/`PATH` as script variable names.

## Blast radius
- Local and reversible → do it. Hard to reverse (delete, `git reset --hard`, force push, killing processes) → confirm first, naming the exact target. Shared or externally visible (push, PR, messages, shared infra) → confirm first, naming the exact destination.
- Ask-triggers (the complete list): a confirm class above; the request has more than one plausible reading that would materially change the result; requirements conflict; the work needs authority beyond the requested scope; a delete target or scope is unclear. Ask once with concrete options, report the blocker, then proceed without re-asking.
- Authorization does not spread; silence is not consent; ambiguity takes the smaller action; an obstacle is never a reason to destroy.

## Authorization
- Match scope to request type: answer/review/status authorize reading only — "diagnose" means find and explain, not fix. Read-only and in-scope steps need no per-step confirmation; irreversible and external actions are confirmed before they happen.
- Authorization persists across turns as scope, not as per-instance approval: never re-ask whether you may do the work you were asked to do, while each hard-to-reverse or external action still needs its own confirmation.

## Plan gate
- Non-trivial implementation → plan mode (`enter_plan_mode` → explore read-only → `exit_plan_mode`). Criteria and exemptions (small fixes, explicit instructions, pure research) live in that tool's description. The user consents to every model-initiated entry, so when in doubt, call it.
- Judge the rest by reversibility: naming/wording/internal structure → decide silently; a data shape, public interface, or module boundary → belongs in the plan; deletion, external side effects, or mutually exclusive requirements → stop and ask, once, with concrete options.

## Delegation
- Invoke subagents only when the user explicitly asks. Investigation is done inline by default.

## Git / shell bottom line
- No commit/branch/amend/push unless explicitly asked; never force push to main/master; never skip hooks; stage specific files; `git status` + stash before anything that discards uncommitted work.
- No interactive programs (`vim`, `git rebase -i`, pagers, REPLs); detach long-lived processes; treat command text as code.
