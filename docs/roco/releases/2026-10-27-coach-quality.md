# Coach quality update — 2026-10-27

The team workshop now previews up to three distinct owned teams before adoption, rather than filling empty slots in box order. Exact locked instances and exclusions remain constraints. Public catalog evolution IDs prefer one member per known evolution family; explicitly locked duplicates stay, and insufficient family coverage is reported. Unknown relationships are not guessed from names or stage numbers.

The ranking uses static race stats and default species moves. It does not establish competitive strength, and a player's current four moves are not fully included in ranking. Evolution relationships use the existing frozen community snapshot as reference data.

In-battle advice no longer lets a single speed detector override a completed current planner result. Planner priority requires exact battle identity, version, legal action, completed branches and stable output. Short advice compares available damage, energy and alternatives while retaining full details. Missing or mismatched evidence remains unavailable.

Reviews now offer a concrete round summary and one next-game check, retaining the detailed evidence. Unknown skills or execution outcomes remain unknown. Team adoption binds instances and forms through the same server receipt, preserving order and chosen moves even when names are duplicated.

Start the normal network-enabled local service:

```bash
ROCO_LOCAL_MODEL=off node scripts/serve-coach.mjs
# Optional alternate port:
PORT=8908 ROCO_LOCAL_MODEL=off node scripts/serve-coach.mjs
```

DeepSeek is configured through `/connect.html`. Credentials are held in the backend process memory; restarting requires reconnecting. This launcher uses the normal HTTPS transport. Offline test transports must not be substituted into the player launcher.

Validation on the integrated revision:

- Related integration tests: 150 passed, zero failed or skipped.
- Existing `test:roco-quality`: 77 passed, zero failed or skipped.
- Live unauthenticated Node HTTPS probe to DeepSeek returned 401, demonstrating network reachability without accessing a user key. This is not authenticated model validation.

These checks do not establish real-model quality, competitive win rate or human learning outcomes.
