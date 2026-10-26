# devteam

The tools 5dive's own team uses to build 5dive: PR delivery (`task deliver --pr`),
graders, gate evidence, proof badges, and the `gh`, `push` and `deploy` rails.

They left the core CLI (DIVE-6935, DIVE-6938). A box that hires agents for anything
else never needs them.

```
sudo 5dive plugin install devteam
```

## How it works

This plugin has no commands of its own. Its `core/` files are read into the 5dive
CLI itself, the same way the CLI reads its own modules, because the CLI calls into
them from its task board. Only this exact plugin may do that: it must come from
5dive's own marketplace, be installed as official, declare the `core` capability,
and every file must be writable by root alone. Any other plugin declaring `core`
is refused at install.

`sudo 5dive doctor --category=plugins` says whether this box runs them from here.

## Since 0.2.0 these files are the code

5dive 0.103 and later carry no copy of them (DIVE-6938). On a box without this
plugin, `proof`, `gh`, `push`, `deploy` and `task deliver|merge…` each answer
with one line, `<verb> is in the devteam plugin: 5dive plugin install devteam`.
The verifier loop stays in the core: a row with no bound pull request still hands
over to its verifier (or closes) on `task done`, and `task reject` still bounces
it back. A row with a bound pull request refuses until the plugin is installed. Older copies (0.1.x) are refused
by a 0.103 core, so upgrade the plugin before or with the CLI:

```
sudo 5dive plugin upgrade devteam@5dive-plugins
```

The CLI reads `core/` on first use in a run, not at every start: it defines one
stub per function here and reads all nine files the first time one is called. A
file here that defines a function the core also defines is refused whole.

`core/SOURCE` is the manifest (sha256 per file). After editing a file:

```
bash tests/devteam_core_unit.sh --rehash
```

and bump the version in `.claude-plugin/plugin.json`.

## Tests

The harnesses for these files moved here with them, unchanged, in
`tests/devteam/`. They still grade a 5dive tree, so the runner clones one, puts
these files back where the core used to keep them, and runs them:

```
bash tests/devteam_core_harnesses.sh --core=/path/to/5dive [name ...]
```

5dive's own CI runs the same runner against every 5dive pull request, and this
repo's CI runs it against 5dive's main.
