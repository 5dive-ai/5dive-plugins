# devteam

The tools 5dive's own team uses to build 5dive: PR delivery (`task deliver --pr`),
graders, gate evidence, proof badges, and the `gh`, `push` and `deploy` rails.

They are leaving the core CLI (DIVE-6935). A box that hires agents for anything
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

## Phase 1 (now)

The core still carries its own copy of every file. A copy here is read only while
it is byte-for-byte the file the installed core was built from, so a fix that lands
in the core is never undone by an older copy here. `core/SOURCE` names the core
commit these are copies of. Refresh after a core change:

```
bash tests/devteam_core_unit.sh --refresh=/path/to/5dive
```

Phase 2 deletes the core copies; from then on these files are the code.
