# yolocage

Sandboxed claude-code / codex in a container, with a built-in egress credential scrubber as the safety net. Run your AI coding agent in `--dangerously-skip-permissions` mode without worrying about accidentally leaking the `.env` file you just `cat`'d into context.

```bash
cd ~/dev/myproject
npx yolocage claude        # or: yc claude
```

That's it. Claude starts in your project directory, using your existing claude.ai login, with HTTP egress to `api.anthropic.com` routed through an in-cage scrubber that catches credential-shaped strings before they reach the LLM.

## What yolocage actually does

When you accidentally `Read .env` or `git config --list` into an agent's context, that secret enters the conversation and gets re-sent to the LLM on every subsequent turn. Once it's in context, hooks can't reach it. Yolocage runs a mitmproxy-based scrubber inside the container that intercepts HTTPS to the LLM provider and same-length-redacts credential-shaped strings out of the request body before they leave the cage.

Yolocage is the opinionated container + CLI wrapper. The scrubber library is published separately as [ssproxy](https://github.com/jlamendo/ssproxy).

## Requirements

- docker (CLI access; yolocage will sudo automatically if you're not in the docker group)
- node 16+ (for npm/npx)

That's it. Mac (Intel + Apple Silicon) and Debian/Ubuntu Linux supported.

## Install

```bash
# One-shot: no install, just run
npx yolocage claude

# Or install globally
npm i -g yolocage
yc claude
```

> The global install registers both `yolocage` and `yc` as commands. Yandex Cloud's CLI also uses `yc` — if you have both, PATH order decides which wins. Invoke `yolocage` to disambiguate, or alias one of them. The conflict is rare enough that the short alias is worth shipping; document over remove.

## Usage

### Shortcut form (one-shot, ephemeral)

```bash
yc                  # defaults to claude in $(pwd)
yc claude           # explicit
yc codex            # codex instead of claude
yc claude -- --resume   # pass-through args after --
```

Equivalent to running `claude` (or `codex`) in your current directory, except the container has a scrubber routing all LLM API calls. Container is removed on exit.

### Named cages (persistent)

```bash
yc create projectbox --type=claude --bind-workspace=./src
yc run projectbox            # attach
yc list                      # show all cages
yc rm projectbox             # destroy
yc logs projectbox           # tail
yc pull                      # refresh yolocage images
yc update                    # update yolocage CLI + images in one shot
```

### Updating yolocage

```bash
yc update              # binary + images
yc update --check      # just report the version delta
yc update --no-pull    # skip the docker pull
yc update --force      # reinstall current version
```

`yc update` runs `npm install -g yolocage@latest` (with sudo if the global prefix needs root) and then re-pulls the cage images. If you installed via `npx` instead of a global install, `yc update` will tell you so and only refresh the images — the next `npx yolocage` invocation fetches the latest binary on its own.

Named cages persist between runs. Use them when you want to maintain in-container state across sessions (with `--tmux`) or want explicit naming for the cage holding your active claude session.

### Configuration

Precedence (lowest to highest):
1. Type defaults (workspace = cwd, config dir = `~/.claude` for claude, `~/.codex` for codex)
2. `~/.ycrc`
3. `./.ycrc` (project-local)
4. CLI flags

#### `.ycrc` syntax

Simple key=value, comments via `#`. Path values expand leading `~` and literal `$HOME` (no other shell expansion):

```
# ~/.ycrc — defaults applied to every cage
type = claude
memory = 4g
tmux = true
ssproxy_extensions = ~/.yolocage/scrubbers.json

# Extra binds appended across layers
extra_bind_dirs = ~/.aws:/home/agent/.aws:ro
```

```
# ./.ycrc — project-local overrides
image = yolocage/claude:1.4.2
extra_bind_dirs = ./secrets:/etc/secrets:ro
```

#### Flags

| flag | meaning |
|---|---|
| `--type=claude\|codex` | which agent (shortcut form embeds this in the verb) |
| `--bind-workspace=PATH` | host path mounted at `/workspace` (default: cwd) |
| `--config-dir=PATH` | host path for the type config dir |
| `--bind-dirs=H:C[:M]` | replaces type defaults (repeatable) |
| `--extra-bind-dirs=H:C[:M]` | appends extra binds (repeatable) |
| `--ssproxy-extensions=PATH` | custom scrub pattern file |
| `--tmux` / `--no-tmux` | run agent inside tmux (default: false) |
| `--memory=2g`, `--cpus=2` | docker resource limits |
| `--image=REPO:TAG` | override default image |

### Cascade semantics

| key | append or replace across layers |
|---|---|
| `type`, `image`, `workspace`, `config_dir`, `memory`, `cpus`, `tmux` | replace (later wins entirely) |
| `bind_dirs` | replace (later layer wins entirely, including its absence) |
| `extra_bind_dirs` | append (union of all layers, dedupe by `host:container`) |
| `ssproxy_extensions` | replace |

## Custom scrub patterns

Companies can extend the scrubber with their own credential patterns:

```bash
yc claude --ssproxy-extensions=./.yolocage/scrubbers.json
```

```json
[
  { "id": "acme-internal-token", "regex": "\\bACME_[A-Z0-9]{32}\\b" },
  { "id": "acme-deploy-key",     "regex": "\\b(acme_deploy_[a-f0-9]{40})(?:[\\x60'\"\\s;]|\\\\[nr]|$)" }
]
```

Patterns are byte-stream regex over the request body. **Use the boundary-anchor convention** shown in the second example — the scrubber does same-length replacement, and a regex without a trailing anchor can overrun the secret boundary into a JSON-structural byte and break the upstream LLM's request parsing. See `docs/writing-scrub-extensions.md`.

## Security model

Yolocage is a **safety net for accidental leakage**, not a defense against a hostile agent.

- The scrubber catches credential-shaped strings on egress to known LLM API hosts. It does not prevent an agent that's already been prompt-injected from exfiltrating data through other channels.
- The cage runs `--dangerously-skip-permissions`. The agent CAN modify any file in your mounted workspace. Don't mount paths you don't want the agent to touch.
- The mitmproxy CA cert lives in a per-cage docker volume; it signs intercepts only of LLM API hosts originating from inside that cage. Blast radius of a leaked CA is "someone with the same yolocage image already on your machine," which means they have bigger problems.

## Open source

- yolocage (this repo): MIT, the opinionated container + CLI
- [ssproxy](https://github.com/jlamendo/ssproxy): MIT, the scrubber library

## License

MIT
