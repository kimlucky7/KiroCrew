"""Turn off git's config-defined hooks for one host-side git call.

Git 2.54 runs hooks named in config, not just hook files::

    [hook "x"]
        command = <any shell command>
        event = pre-commit

``-c core.hooksPath=<devnull>`` only moves the hook DIRECTORY, so these still
run. A repository's own ``.git/config`` is writable by whoever edits the tree,
so a host-side git call over an agent-writable tree would run that command
outside the sandbox. They fire on ordinary porcelain: ``add``, ``commit``,
``checkout``, ``worktree add``, ``push``, ``fetch``, ``update-ref``, and even
``status`` when it refreshes the index (``post-index-change``).

There is no switch that turns them all off. ``hook.<event>.enabled=false``
(git 2.55+) is ignored when the same ``<event>`` is also used as a hook name,
which the repository can arrange. ``hook.<name>.enabled=false`` works on every
version that has config hooks, but only for a name we know. So each call first
lists the names git will see and disables each one by name. Older git ignores
the extra keys.

Every scope is disabled, not just the repository's: the callers already point
``core.hooksPath`` at the null device, so the user's own hooks never ran on
these calls either.

How the scan runs
-----------------

Each git call the scan makes goes through a *runner*. The default runner spawns
git directly, which is right for callers that already run their real git call
unsandboxed (they pin ``.git/info/attributes`` and the ``-c`` overrides
instead). A caller whose REAL git call runs inside the OS sandbox passes a
runner that spawns the scan THROUGH that same sandbox
(:func:`config_hook_disable_args_sandboxed`), so the scan is confined exactly
like the call it protects and never execs a bare-``PATH`` git unsandboxed.

The list is read just before the call, by a separate process, so a writer that
is running at the same moment can add a new name in between. That is the same
limit the ``.git/info/attributes`` pin in
:mod:`kiro_crew.apps.builtins.auto_improvement.spine.git_safety` has.
"""

from __future__ import annotations

import os
import subprocess
from collections.abc import Callable, Mapping

__all__ = [
    "ConfigHookScanError",
    "config_hook_disable_args",
    "config_hook_disable_args_sandboxed",
]

#: More names than this is refused rather than passed on: no real setup has this
#: many, and each one costs two argv entries.
_MAX_HOOK_NAMES = 256

#: Individual names longer than this (in UTF-8 bytes) cannot be passed as ``-c``
#: arguments on any realistic platform without risking E2BIG. Reject them early
#: so a single enormous name in the repository config cannot crash a call site.
_MAX_HOOK_NAME_BYTES = 512

#: Ceiling on how many repositories (the superproject's submodules, their
#: submodules, and so on) the recursive walk will scan. A pathological nest
#: cannot turn one git call into an unbounded number of scan subprocesses.
_MAX_SUBMODULE_REPOS = 256

_SCAN_TIMEOUT_SECS = 10

#: Bound once, so a stand-in a caller's tests install for ``subprocess.run`` (to fake
#: that caller's own git) does not also answer this scan.
_run = subprocess.run

#: Runs one git argv and returns ``(returncode, stdout, stderr)``. May raise
#: ``FileNotFoundError`` (git absent -> treated as "nothing to disable"),
#: ``RuntimeError`` (the sandbox could not confine the spawn -> fail closed), or
#: another ``OSError``/``subprocess.SubprocessError`` (unreadable -> fail closed).
_ScanRunner = Callable[[list[str]], "tuple[int, bytes, bytes]"]


class ConfigHookScanError(RuntimeError):
    """The hook names could not be listed safely, so the git call must not run."""


def _add_hook_name(name: str, names: list[str], seen: set[str]) -> None:
    """Validate one hook name and append it to ``names`` (deduping via ``seen``).

    One home for every rule the superproject scan and the submodule scan share, so a
    rule added here applies to both. Raises :class:`ConfigHookScanError` for a name that
    could not be disabled safely (contains ``=``, exceeds :data:`_MAX_HOOK_NAME_BYTES`,
    or pushes the total over :data:`_MAX_HOOK_NAMES`).
    """
    if name in seen:
        return
    if "=" in name:
        raise ConfigHookScanError(
            f"git hook name {name[:80]!r} contains '=' and cannot be disabled"
        )
    name_bytes = name.encode("utf-8", "surrogateescape")
    if len(name_bytes) > _MAX_HOOK_NAME_BYTES:
        raise ConfigHookScanError(
            f"git hook name is {len(name_bytes)} bytes (limit {_MAX_HOOK_NAME_BYTES})"
        )
    seen.add(name)
    names.append(name)
    if len(names) > _MAX_HOOK_NAMES:
        raise ConfigHookScanError(
            f"git config defines {len(names)} hook names (limit {_MAX_HOOK_NAMES})"
        )


def _default_runner(env: Mapping[str, str] | None) -> _ScanRunner:
    """A runner that spawns git directly, for callers whose real call is unsandboxed."""
    env_dict = dict(env) if env is not None else None

    def run(argv: list[str]) -> tuple[int, bytes, bytes]:
        # Exceptions propagate: the call sites below map FileNotFoundError to [] and
        # every other spawn fault to a ConfigHookScanError (fail closed), exactly as
        # the direct-spawn scan always did.
        proc = _run(
            argv,
            env=env_dict,
            stdin=subprocess.DEVNULL,
            capture_output=True,
            timeout=_SCAN_TIMEOUT_SECS,
            check=False,
        )
        return proc.returncode, proc.stdout, proc.stderr

    return run


def _submodule_hook_names(cwd: str | os.PathLike[str], git: str, run: _ScanRunner) -> list[str]:
    """Hook names defined in every gitlinked submodule reachable from ``cwd``, recursively.

    A ``git status``/``diff`` in the superproject spawns a CHILD git in each submodule it
    checks, that child spawns one in each of ITS submodules, and so on -- each reading its
    OWN config, which the agent can write. So every level's hook names must be disabled;
    the ``-c hook.<name>.enabled=false`` flags reach a child AND a grandchild through
    ``GIT_CONFIG_PARAMETERS`` (verified two levels deep on git 2.55).

    Each submodule is scanned by running git IN its own working tree (``git -C <dir>
    config --get-regexp``), not by reading a fixed ``.git/modules/*/config`` path. That
    covers an ABSORBED submodule (gitdir under ``.git/modules``) and a NON-ABSORBED nested
    ``sub/.git`` alike, and lets git itself resolve ``include.path`` the same way the child
    will. Gitlinks are found with ``ls-files -s`` (mode ``160000``) from the work-tree
    TOPLEVEL, so a ``cwd`` deep in the tree still finds them. A submodule with no
    checked-out working tree, or any git error running IN it, is skipped: no child git runs
    there, so there is nothing to disable. A repository with no gitlinks adds no work beyond
    the one ``ls-files``. The walk is cycle-guarded (by real path) and bounded by
    :data:`_MAX_SUBMODULE_REPOS`, so a self-referential or enormous nest cannot loop or
    fan out without limit.
    """

    def _exec(argv: list[str]) -> tuple[int, bytes, bytes] | None:
        # Below the superproject the scan is best-effort: a submodule we cannot run git in
        # is one no child git runs in either. (A sandbox refusal cannot reach here -- the
        # superproject scan uses the same runner and would have failed closed first.)
        try:
            return run(argv)
        except (OSError, subprocess.SubprocessError, RuntimeError):
            return None

    top = _exec(
        [git, "-C", os.fspath(cwd), "-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"]
    )
    if top is None or top[0] != 0:
        return []
    toplevel = top[1].decode("utf-8", "surrogateescape").strip()
    if not toplevel:
        return []

    names: list[str] = []
    seen_names: set[str] = set()
    visited: set[str] = set()
    stack: list[str] = [toplevel]
    scanned = 0
    while stack:
        repo_dir = stack.pop()
        real = os.path.realpath(repo_dir)
        if real in visited:
            continue  # cycle: a submodule that points back at an ancestor
        visited.add(real)
        scanned += 1
        if scanned > _MAX_SUBMODULE_REPOS:
            break
        listed = _exec([git, "-C", repo_dir, "-c", "core.fsmonitor=false", "ls-files", "-s", "-z"])
        if listed is None or listed[0] != 0:
            continue
        for entry in listed[1].split(b"\0"):
            if not entry.startswith(b"160000 "):
                continue  # only gitlinks (submodules)
            # Format: "<mode> <oid> <stage>\t<path>"
            tab = entry.find(b"\t")
            if tab == -1:
                continue
            rel = entry[tab + 1 :].decode("utf-8", "surrogateescape")
            sub_dir = os.path.join(repo_dir, rel)
            cfg = _exec(
                [
                    git,
                    "-C",
                    sub_dir,
                    "config",
                    "--includes",
                    "-z",
                    "--name-only",
                    "--get-regexp",
                    r"^hook\.",
                ]
            )
            if cfg is None:
                continue  # cannot run git in this submodule -> no child runs there either
            if cfg[0] not in (0, 1):
                continue
            for raw in cfg[1].split(b"\0"):
                key = raw.decode("utf-8", "surrogateescape")
                if not key.startswith("hook."):
                    continue
                rest = key[len("hook.") :]
                if "." not in rest:
                    continue
                name = rest[: rest.rindex(".")]
                if name not in seen_names:
                    seen_names.add(name)
                    names.append(name)
            # Recurse: this submodule can itself contain gitlinks whose child git also runs.
            stack.append(sub_dir)
    return names


def config_hook_names(
    cwd: str | os.PathLike[str],
    *,
    git: str = "git",
    env: Mapping[str, str] | None = None,
    runner: _ScanRunner | None = None,
) -> list[str]:
    """Every ``hook.<name>.*`` name git would read in ``cwd``, from all scopes.

    Also scans each gitlinked submodule -- and its submodules, recursively -- by running
    ``git`` in the submodule's own working tree, because git spawns a child process in each
    submodule it checks (e.g. during ``status`` when a submodule is dirty), and that child
    reads the submodule's own config independently. The submodule hook names are returned
    alongside the superproject's, so the caller disables them all. The ``-c
    hook.<name>.enabled=false`` flags reach a submodule child -- and a grandchild -- through
    ``GIT_CONFIG_PARAMETERS`` (git propagates ``-c`` to submodule subprocesses), so
    disabling by name is enough -- verified two levels deep on git 2.55.

    ``git`` and ``env`` should be what the real call uses, so both find the same binary and
    see the same config files. ``runner`` executes each scan git argv; the default spawns
    git directly, and :func:`config_hook_disable_args_sandboxed` supplies one that spawns
    through the caller's OS sandbox. A ``cwd`` that is not a directory, or a ``git`` that
    cannot be found, returns ``[]``: the real call fails on its own there.

    Raises :class:`ConfigHookScanError` when the listing fails (an unreadable config),
    when a name contains ``=`` (``-c`` splits on the first ``=``, so it could not be
    disabled), when any name exceeds :data:`_MAX_HOOK_NAME_BYTES`, or when there are more
    than :data:`_MAX_HOOK_NAMES` names. A runner's OWN spawn failure (e.g. the sandbox
    cannot confine the scan) propagates unchanged, so the caller maps it exactly like its
    real call's spawn failure.
    """
    if not os.path.isdir(cwd):
        return []
    run = runner if runner is not None else _default_runner(env)
    argv = [
        git,
        "-C",
        os.fspath(cwd),
        "-c",
        "core.fsmonitor=false",
        "config",
        "-z",
        "--name-only",
        "--get-regexp",
        r"^hook\.",
    ]
    try:
        rc, out, errb = run(argv)
    except FileNotFoundError:
        # No such git under this name and PATH: the real call, which spawns the same name
        # with the same environment, cannot run either, so there is nothing to disable.
        return []
    except (OSError, subprocess.SubprocessError) as exc:
        raise ConfigHookScanError(f"could not list git hook config: {exc}") from exc
    # 0 = keys found, 1 = no matching key. Anything else is an unreadable config, which
    # the real call would also choke on; refuse rather than guess.
    if rc not in (0, 1):
        tail = errb.decode("utf-8", "replace").strip()[-200:]
        raise ConfigHookScanError(f"could not list git hook config ({rc}): {tail}")
    names: list[str] = []
    seen: set[str] = set()
    for raw in out.split(b"\0"):
        # surrogateescape so a non-UTF-8 name goes back to git byte-for-byte.
        key = raw.decode("utf-8", "surrogateescape")
        if not key.startswith("hook."):
            continue
        rest = key[len("hook.") :]
        if "." not in rest:
            continue  # `hook.jobs`: a setting, not a named hook
        _add_hook_name(rest[: rest.rindex(".")], names, seen)
    # Also disable hooks defined in gitlinked submodules (and their submodules): a child
    # git spawned in a submodule reads the submodule's own config, which the agent can write.
    for name in _submodule_hook_names(cwd, git, run):
        _add_hook_name(name, names, seen)
    return names


def config_hook_disable_args(
    cwd: str | os.PathLike[str],
    *,
    git: str = "git",
    env: Mapping[str, str] | None = None,
    runner: _ScanRunner | None = None,
) -> list[str]:
    """``-c hook.<name>.enabled=false`` argv entries; place them before the subcommand.

    Empty when no hook is configured. Raises like :func:`config_hook_names`.
    """
    args: list[str] = []
    for name in config_hook_names(cwd, git=git, env=env, runner=runner):
        args += ["-c", f"hook.{name}.enabled=false"]
    return args


def config_hook_disable_args_sandboxed(
    cwd: str | os.PathLike[str],
    *,
    spawn_argv: Callable[..., tuple[list[str], dict[str, str], str | None]],
    mode: str,
    env: Mapping[str, str] | None = None,
) -> list[str]:
    """Like :func:`config_hook_disable_args`, but for callers whose REAL git call runs
    inside the OS sandbox.

    The scan runs the SAME way the real call runs: each scan git argv is wrapped by the
    caller's own ``spawn_argv`` (:func:`kiro_crew.sandbox.sandboxed_spawn_argv`) at the
    caller's own ``mode`` and ``env``, then spawned. So the scan is confined exactly like
    the call it protects, with the caller's own ``git`` -- never a bare-``PATH`` git run
    unsandboxed, and never dependent on a "trusted" git existing in a fixed system dir
    (which would leave config hooks enabled on a host whose git lives elsewhere, e.g.
    Scoop/winget/nix/brew). It is fail-closed: if the sandbox cannot confine the scan, or
    the config cannot be read, the scan refuses (``ConfigHookScanError`` for an unreadable
    config; the spawn's own error -- e.g. ``RuntimeError`` when no sandbox backend exists
    and no opt-in is set -- propagated unchanged) and the caller must refuse the git call,
    mapping it the same way it maps a real-call spawn failure. A host with no hooks
    configured produces no flags and the real call runs exactly as before.
    """
    base_cwd = os.fspath(cwd)

    def run(argv: list[str]) -> tuple[int, bytes, bytes]:
        # RuntimeError from spawn_argv (no sandbox backend and no opt-in) propagates:
        # config_hook_names turns it into a ConfigHookScanError (fail closed).
        wrapped, scrubbed, cleanup = spawn_argv(argv, mode=mode, env=env)
        scrubbed["GIT_TERMINAL_PROMPT"] = "0"
        try:
            proc = _run(
                wrapped,
                cwd=base_cwd,
                env=scrubbed,
                stdin=subprocess.DEVNULL,
                capture_output=True,
                timeout=_SCAN_TIMEOUT_SECS,
                check=False,
            )
        finally:
            if cleanup:
                try:
                    os.unlink(cleanup)
                except OSError:
                    pass
        return proc.returncode, proc.stdout, proc.stderr

    return config_hook_disable_args(cwd, git="git", env=env, runner=run)
