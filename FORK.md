# CrazyCoder/rpiv-mono — patched fork

Upstream: <https://github.com/juicesharp/rpiv-mono>

`main` tracks upstream `main` with a short stack of patches on top, so the
patched `rpiv-ask-user-question` extension can be installed straight from git on
any machine instead of from a local checkout.

## Install

In `~/.pi/agent/settings.json`:

```json
"packages": [
  "git:github.com/CrazyCoder/rpiv-mono@main"
]
```

Pi has no subdirectory syntax for `git:` sources — it clones the repository root
and reads the `pi` field of the root `package.json`. The root manifest in this
fork therefore points into the workspace:

```json
"pi": { "extensions": ["./packages/rpiv-ask-user-question/index.ts"] }
```

Only `ask_user_question` is registered. The other `rpiv-*` packages in the
monorepo stay dormant — install those from npm if you want them.

Pi clones to `~/.pi/agent/git/github.com/CrazyCoder/rpiv-mono` and runs
`npm install --omit=dev` in the clone root, which resolves the workspace links
the extension needs (`@juicesharp/rpiv-config`, `typebox`). npm skips the root
`prepare` script under `--omit=dev`, so the `husky` dev dependency is not
required. Refresh with `pi package update`, which hard-resets and reinstalls the
clone.

## Patches carried on top of upstream

| Commit | Upstream | What |
| --- | --- | --- |
| `fix(ask-user-question): preserve custom multi-select input` | PR #196, open | Custom text coexists with checked options in multi-select instead of clearing them; the custom row's checkbox tracks nonblank input; the same contract applies over RPC. |
| `fix(rpiv-ask-user-question): reduce tool description and guideline tokens` | PR #110, open | Removes the overlap between the tool description and the prompt guidelines. Rebased onto the current text, since the July original no longer applied, and corrected: that patch had collapsed a sentence whose subject was the "Type something." row into a claim about `multiSelect`, which contradicted the single-select-only preview rule one line below. |
| `fix(rpiv-ask-user-question): surface saved answer notes and label them` | issue #197 | Keeps a committed note on screen on the question tab once its editor closes — a single-question run has no Submit tab, so it previously had no surface at all — and labels it `Note for this answer:` through the i18n bridge on both surfaces. |
| `fix(rpiv-ask-user-question): normalize rather than reject on questionnaire parity` | fork-only | Three shapes Claude Code accepts were rejected here: a header over 16 characters, a label over 60, and an authored `"Other"`. The two `maxLength` caps are gone (over-long text now truncates in the chip and clips or wraps in the column), and an authored `"Other"` is dropped instead of failing the call. Upstream rejects these deliberately, so this is not PR material as it stands. |

Issue #197 also reports that the custom-answer draft is lost. That half is not a
defect. The focus round trip it describes is already handled by `navHandler`,
which snapshots the live buffer into `customDraftsByTab` on the way out and
re-seeds it on the way in; the tab-switch variant is unreachable because
`routeInputMode` swallows Tab while `inputMode` is active, so no `tab_switch`
action can be dispatched from that row. A regression test pins the working
behavior rather than changing it.

The parity commit deliberately does NOT truncate labels. A label is the answer
identity and is echoed back verbatim, so rewriting one would report an answer
that was never offered, and two labels differing only past the cut would collapse
into a single ambiguous row. It also drops only `"Other"`, never the other two
reserved labels: `"Type something."` and `"Next"` are this dialog's sentinels but
ordinary option labels elsewhere, and dropping them would delete a real choice.

## Re-syncing with upstream

The patches are ordinary commits on `main`:

```sh
git fetch origin                    # origin = juicesharp/rpiv-mono
git rebase origin/main
git push --force-with-lease fork main
```

Drop any commit whose PR has landed upstream. Keep the root manifest commit last
so it stays easy to identify — it is fork-only and must never go upstream.

## Tests

`npx vitest run packages/rpiv-ask-user-question`

Three failures are pre-existing on Windows and also fail on a pristine
`origin/main` checkout: one in `ship-manifest.test.ts` and two in
`state/external-editor.test.ts`, all from path and shell assumptions.
