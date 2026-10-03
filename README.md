# npm-probing-package

Dependency-free research probes for the environment visible **during npm installation**.
Requires Node.js 22+. All 200 environment and installation-context catalog properties are registered.
Unselected properties are included with `value: null, status: "disabled"`.

## Property catalog

[`catalog/npm-install-environment-properties.csv`](catalog/npm-install-environment-properties.csv)
is an unchanged copy of the supplied 200-property list and the authoritative source
of report keys. It is shipped in the npm tarball. Its contents are treated as data.

## Installation and output

`postinstall` runs `scripts/postinstall.js` once whenever npm invokes that lifecycle
hook. It collects a snapshot and writes `install-<UUID>.json`. A repeated hook run
gets a new filename. Output directories are tried in this order:

1. `NPM_PROBE_OUTPUT_DIR`, if configured (prefer an absolute path).
2. `results/` inside the installed copy of this package.
3. `npm-probing-package-results/` inside Node's OS temporary directory.

For example, a dependency installation normally writes beneath
`node_modules/npm-probing-package/results/`. The hook prints the final path to
stderr. Use `npm install --foreground-scripts` to see lifecycle output directly.
Reports are written through a temporary file and renamed after completion.
Permissions request owner-only access where the OS supports it. Generated reports
are ignored by Git and excluded from the npm tarball.

To exercise installation in this repository:

```sh
npm install --foreground-scripts
```

For research deployments, pack this package with `npm pack` and install the tarball
in the target environment. It remains `private` until a publishable name and license
are chosen. This hook observes installation of **this package**, not every other
dependency. Each research package that needs its own observation must include the
hook and its supporting files.

No probes run automatically on import, application startup, or a timer. The hook
does nothing when directly executed outside the `postinstall` lifecycle. npm
rebuilds and an explicit `npm run postinstall` can also invoke the hook; these
reports have the same phase label and should be distinguished by the research
harness if needed. An install that reuses an existing package may not rerun its hook.
When lifecycle scripts are disabled (for example, `--ignore-scripts`), this package
cannot collect a report. A scanner must execute lifecycle scripts to be observed.
See [npm lifecycle documentation](https://docs.npmjs.com/cli/v11/using-npm/scripts/).

## Report format

The following is an abbreviated report; actual reports contain all 200 keys:

```json
{
  "schemaVersion": 2,
  "runId": "unique-UUID-for-this-invocation",
  "collectedAt": "2026-10-03T08:00:00.000Z",
  "properties": {
    "Operating system family": { "value": "Linux", "status": "ok" },
    "Operating system distribution identifier": { "value": "ubuntu", "status": "ok" },
    "Ancestor project workspace configuration presence": { "value": false, "status": "ok" }
  },
  "phase": "postinstall",
  "package": { "name": "npm-probing-package", "version": "0.1.0" }
}
```

Each property has exactly two keys, `value` and `status`. Unavailable values are
`null`. The status vocabulary is:

| Status | Meaning |
| --- | --- |
| `ok` | The value was obtained. |
| `absent` | The supported source or requested field is missing/empty. |
| `unsupported` | The platform/API/source type is unsupported. |
| `permission_denied` | The runtime or OS denied access. |
| `timeout` | The probe exceeded its deadline. |
| `error` | An unexpected failure or malformed source/result occurred. |
| `truncated` | A size limit was reached; the value is a partial string or `null`. |
| `disabled` | The property is not selected or not implemented yet. |

Schema 2 replaces the initial scaffold's grouped `probes` array with a property
map. The old `runtimeProbe` export has been replaced by `createOSProbes`.

## Implemented sources and interpretation

| Property | Source / value |
| --- | --- |
| Operating system family | `os.type()`: e.g. `Linux`, `Darwin`, `Windows_NT` |
| Operating system distribution identifier | Linux `ID`; macOS `macos`; Windows `windows` |
| Operating system distribution version | Linux `VERSION_ID`; macOS `sw_vers -productVersion`; Windows `os.release()` (numeric release/build, not marketing version) |
| Operating system distribution family | Linux `ID_LIKE` string, preserving multiple entries; macOS `darwin`; Windows `windows` |
| Kernel release | `os.release()` |
| Kernel version string | `os.version()` |
| Machine architecture | `os.machine()`, e.g. `x86_64` |
| Node.js process architecture | `process.arch`, e.g. `x64` |
| System byte order | `os.endianness()`: `LE` or `BE` |
| Operating system uptime in seconds | `os.uptime()`; a number, including zero |

The native methods follow the [Node OS API](https://nodejs.org/api/os.html).
Machine architecture is kept separate from the architecture of the Node binary.
Byte order describes the executing binary's CPU view. In containers, emulation,
CI, and sandboxes these values describe the exposed environment and may differ
from the physical host. Uptime may be host uptime, not container or install age.
No attempt is made to identify scanners or change behavior for them.

Linux reads `/etc/os-release`, falling back to `/usr/lib/os-release` only if the
first path is missing. It does not merge the two files, guess missing distribution
fields, or substitute a kernel version for a missing distribution version. Missing
`ID_LIKE` or rolling-release `VERSION_ID` fields are `absent`. Distribution fields
on platforms other than Linux/macOS/Windows are `unsupported`; native OS probes
still run. The file is parsed without shell execution or variable expansion. See
the [systemd os-release specification](https://www.freedesktop.org/software/systemd/man/latest/os-release.html).

## CPU sources and normalization

The nine CPU probes run in the same installation snapshot and use the same
`value`/`status` format. CPU metadata and Linux cpuinfo are each sampled once per
collection, with no cached observations carried into a later collection.

| Property | Source / value |
| --- | --- |
| CPU vendor | Sorted unique vendor names inferred from explicit Intel, AMD, Apple, Qualcomm, IBM, or NVIDIA brands in `os.cpus()` model strings; otherwise `absent` |
| CPU model | Sorted unique model strings with trimmed/collapsed whitespace |
| Reported logical CPU count | `os.cpus().length`; an empty metadata array yields `absent`, not a claim of zero CPUs |
| Physical CPU core count when exposed | Linux: number of distinct `(physical id, core id)` pairs in `/proc/cpuinfo`; macOS: `/usr/sbin/sysctl -n hw.physicalcpu`; other platforms: `unsupported` |
| Process-available parallelism | `os.availableParallelism()`; independent of logical CPU count |
| CPU affinity mask | Linux `/proc/self/status` `Cpus_allowed_list`, preserved as a CPU-list string such as `0-3,8`; other platforms: `unsupported` |
| CPU nominal clock speed | Sorted unique positive `os.cpus()` speed values in MHz; zero/unavailable readings yield `absent` |
| CPU hypervisor flag presence | Linux: boolean indicating whether any processor's `flags` includes `hypervisor`; missing/empty flags yield `absent`; other platforms: `unsupported` |
| CPU instruction-set flags | Linux: sorted intersection of `flags` (x86) or `Features` (ARM) across processor records; missing/empty fields yield `absent`; other platforms: `unsupported` |

Vendor, model, and speed values are arrays even when only one distinct value exists.
If any logical CPU has an unknown vendor, missing model, or unavailable speed, that
respective property is `absent` rather than an apparently complete partial list.
Node has no dedicated vendor field; vendor labels here are conservative brand
inferences, not direct hardware vendor identifiers. MHz values are the OS-reported
sample and can vary with CPU frequency scaling; they do not guarantee rated/base
clock speed. See the [Node CPU metadata API](https://nodejs.org/api/os.html#oscpus).

Linux cpuinfo reads are capped at 1 MiB and status reads at 64 KiB. Oversized input
produces `truncated` with `null`; incomplete topology produces `absent` without
guessing from logical counts or a single socket's `cpu cores` field. Physical counts
describe exposed topology, not a container CPU quota. This implementation uses
proc topology; Linux systems exposing topology only in sysfs currently yield `absent`.
CPU lists are validated without expanding potentially large ranges. macOS sysctl
uses a fixed executable, no shell, a one-second deadline and 4 KiB output cap.

ARM `Features` alone cannot establish a negative x86 hypervisor-bit result. A false
hypervisor flag value does not prove bare-metal execution. The instruction flags
intersection describes common exposed flags, not a guarantee that every instruction
is executable under every runtime restriction. Sources may be filtered by the
environment. See the [Linux proc documentation](https://docs.kernel.org/filesystems/proc.html).

## Memory, cgroups and resource limits

These 15 probes use the existing installation hook and property status vocabulary.
Only the two native memory probes run on non-Linux platforms; the remaining 13
report `unsupported` there.

| Property | Source / units |
| --- | --- |
| Total host-visible memory bytes | `os.totalmem()` |
| Available host-visible memory bytes | `os.freemem()`; free memory, not Linux `MemAvailable` |
| Total / available swap bytes | `/proc/meminfo` `SwapTotal` / `SwapFree`; multiply kernel kB by 1024 |
| Cgroup CPU quota / period | v2 `cpu.max` fields; v1 `cpu.cfs_quota_us` / `cpu.cfs_period_us`; microseconds, not CPU counts |
| Cgroup effective CPU set | v2 `cpuset.cpus.effective`; v1 `cpuset.effective_cpus`; CPU-list string |
| Cgroup memory limit / current usage bytes | v2 `memory.max` / `memory.current`; v1 `memory.limit_in_bytes` / `memory.usage_in_bytes` |
| Cgroup process-count limit / current count | `pids.max` / `pids.current` in both versions; kernel task counts include threads |
| Process open-file soft / hard limit | `/proc/self/limits` `Max open files`, respective columns |
| Process address-space limit | `/proc/self/limits` `Max address space`, **soft** limit in bytes |
| Process stack-size limit | `/proc/self/limits` `Max stack size`, **soft** limit in bytes |

Native memory values describe what the OS exposes and are not substituted with
cgroup limits. Zero swap or zero current usage is valid `ok` data. An empty exposed
effective CPU set is `""` with `ok`; a missing field/file is `absent`. Configured
`cpuset.cpus` is not used as a substitute for an unavailable effective set.

Cgroup resolution reads `/proc/self/cgroup` and `/proc/self/mountinfo`, accounting
for controller-specific v1 memberships, v2, hybrid layouts, mount roots, and escaped
mount paths. It chooses the most specific matching visible mount. It does not
assume `/sys/fs/cgroup` is the process's group. Unresolvable or hidden memberships
yield `absent`; access failures retain their own status. Paths with traversal
components are rejected. Namespace-relative membership paths must match the exposed
mount root; the collector does not guess a translation when they do not match.

Values describe the current group's files, not the most restrictive ancestor
limit or an effective CPU quota calculation. Ancestors can impose tighter limits.
The pids controller counts tasks, so these catalog properties are not a count of
distinct process IDs. See the [cgroup v2 reference](https://docs.kernel.org/admin-guide/cgroup-v2.html)
and [v1 memory reference](https://docs.kernel.org/admin-guide/cgroup-v1/memory.html).

`max`, v1 CPU quota `-1`, and process `unlimited` values become `"unlimited"` with
`ok`. Other nonnegative integers use JSON numbers when exactly representable;
larger integers use decimal strings. Large v1 memory-limit sentinel values are
preserved exactly as reported, without assuming an architecture-specific sentinel
means unlimited. Consumers must accept number or string values for numeric limits.

Reads are cached only within a collection: 64 KiB per source, with 1 MiB for
mountinfo. Oversized files yield `truncated` with `null`; reads use the existing
deadlines and abort signals. Shared-file sampling avoids rereading a changing
`cpu.max` for quota and period, but the entire report is not an atomic OS snapshot.

## User, host and session properties

These 18 registered properties use the same installation snapshot and status
format. Windows elevation is an optional helper interface, not a bundled native
implementation; it currently returns `unsupported` in the default installation.

| Property | Value and source |
| --- | --- |
| Username length | Unicode code-point count of `os.userInfo().username` |
| Username generic-account pattern | Boolean exact, case-insensitive match against the fixed account-name list below |
| Hostname length | Unicode code-point count of `os.hostname()` |
| Hostname character-pattern class | First matching class: `non_ascii`, `numeric`, `hexadecimal`, `alphabetic`, `alphanumeric`, `hyphenated`, `dotted`, `mixed` |
| Hostname container-like pattern | Boolean: 12/64 hexadecimal characters, or a lowercase pod-style name ending in an 8–10-character alphanumeric segment and a 5-character segment |
| Effective user / group ID | `process.geteuid()` / `process.getegid()`; unavailable APIs yield `unsupported` |
| Supplementary group count | Number of distinct IDs returned by `process.getgroups()`; includes the effective group as Node reports it |
| Effective root status | Effective UID equals zero; this does not establish host-wide privileges |
| Windows process elevation status | Optional Windows token-query helper result; no username or group-membership inference |
| Process umask | Getter-only `process.umask()`, represented as four octal digits, e.g. `0022` |
| Login-shell executable basename | POSIX `SHELL` basename, or Windows `ComSpec`/`COMSPEC` basename; an environment hint, not verification of the actual login shell |
| Home / working / temporary normalized path templates | `os.homedir()` / `process.cwd()` / `os.tmpdir()`, sanitized as described below |
| Standard input / output / error terminal status | Boolean `isTTY === true`; undefined `isTTY` on an existing redirected stream is `false`; an unavailable stream is `unsupported` |

The fixed generic account list is: `root`, `admin`, `administrator`, `user`,
`guest`, `nobody`, `node`, `runner`, `ubuntu`, `debian`, `vagrant`, `docker`,
`jenkins`, `buildkite`, `circleci`, `gitlab-runner`, `ci`, `build`, `builder`,
`test`, `sandbox`, `ec2-user`. These and the hostname patterns are heuristics,
not definitive account roles or container detection. Empty identity strings yield
`absent`; false pattern matches remain valid `ok` values.

Raw usernames and hostnames are discarded after deriving the fields; they are not
included in reports. Path templates preserve only the fixed structural vocabulary
defined in `src/probes/session.js`; arbitrary directory names become `<dir>`,
home account components become `<user>`, and node_modules names become `<scope>`
or `<package>`. Roots become `<posix-root>`, `<drive>`, `<unc-root>`,
`<device-root>` or `<windows-root>`. UNC host/share names and drive letters are
discarded. No filesystem traversal or symlink resolution is performed.

For example, `/home/alice/project/node_modules/@company/tool` becomes
`<posix-root>/home/<user>/<dir>/node_modules/<scope>/<package>`. Templates retain
directory structure and selected standard names, not enough information to
reconstruct a private path. Invalid relative paths yield `error` rather than
being copied verbatim. The explicitly requested shell basename and numeric IDs
are retained.

An optional Windows helper can be injected through
`createSessionProbes({ elevationQuery: async ({ signal }) => boolean })` and used
in the probe registry. It must query the current process token, honor cancellation,
and return a boolean; helper errors use the existing status mapping. No helper is
executed on other platforms. See the [Node process API](https://nodejs.org/api/process.html)
and [TTY API](https://nodejs.org/api/tty.html) for native source behavior.

## Node runtime properties

Fourteen probes report the Node process executing the installation script:

| Property | Source / representation |
| --- | --- |
| Node.js version | `process.versions.node`, falling back to `process.version` without its leading `v` |
| V8, module ABI, N-API, libuv, OpenSSL, ICU versions | Respective `process.versions` fields, retained as strings; missing/empty fields are `absent` |
| Node.js executable normalized path template | `process.execPath`, using the session path normalizer |
| Inspector activation flag presence | Boolean presence of `--inspect`, `--inspect-brk`, or `--inspect-wait` in startup tokens, including `=value` and underscore variants |
| Require-preload flag presence | Boolean presence of `--require`, `--require=value`, `-r value`, or `-rvalue`; ESM `--import` is not a require preload |
| NODE_OPTIONS / NODE_PATH variable presence | Boolean own-key presence, including variables set to an empty string |
| NODE_ENV value | Raw string as requested; unset is `absent`, empty is `ok`; collector string limits apply |
| Node.js module-search-path normalized templates | Ordered CommonJS search-path templates relative to the installation script, including global search paths exposed by Node |

The two flag probes inspect `process.execArgv` and tokenize `NODE_OPTIONS` using
Node's double-quote/escape rules, without executing a shell or loading preloads.
They discard token contents after deriving booleans. Recognized value-taking options
(including eval, require, import, title and inspector port) consume their following
argument; quoted values and code containing flag-like text do not count as flags.
`--inspect-port`, `--inspect-publish-uid`, and negated flags alone do not indicate
activation. A positive flag followed by a disabling flag still reports presence.
These are observations of visible startup metadata, not a live inspector query or
proof a preload ran. Runtime changes to environment variables can differ from the
original launch environment. See the [Node CLI reference](https://nodejs.org/api/cli.html#node_optionsoptions).

Input limits are 64 KiB of characters per startup source and 4,096 argument tokens.
Oversized sources produce `truncated`/`null`; malformed quotes produce `error`/`null`.
Presence-only probes still succeed independently of parsing failures. Future
value-taking flags may require additions to the explicit parser list.

Module paths use `createRequire()` anchored at `scripts/postinstall.js` and
`require.resolve.paths()` with a bare placeholder name. This asks for lookup paths
without resolving or loading that module. Paths are normalized in search order,
including duplicates produced by redaction; relative entries are first resolved
against the process working directory. At most 128 paths are retained, with
`truncated` when the list exceeds that bound. No raw `NODE_PATH` string or private
search-directory names are reported. This describes CommonJS lookup locations,
not all ESM resolution rules. See the [Node module API](https://nodejs.org/api/module.html#modulecreaterequirefilename).

## npm and installation context

Fifteen probes read selected lifecycle environment variables and the working directory. They do not run a
package manager, read npmrc files, enumerate configuration, or retain a raw user
agent or executable path.

| Property | Source / normalization |
| --- | --- |
| Package-manager identity | Leading `npm_config_user_agent` product when it is `npm`, `pnpm`, `yarn`, or `bun`; otherwise a recognized `npm_execpath` basename |
| Package-manager version | Validated three-component version from that leading product, optionally including prerelease/build syntax; no version guessed from an executable path |
| npm lifecycle event name | `npm_lifecycle_event` |
| npm command name when exposed | `npm_command` |
| npm global-install configuration | `npm_config_global`, parsed as boolean from `true`/`false` or `1`/`0` |
| npm omit configuration | `npm_config_omit`, normalized to a sorted, unique array of `dev`, `optional`, `peer` |
| npm script-shell normalized path template | `npm_config_script_shell` |
| npm cache normalized path template | `npm_config_cache` |
| npm prefix normalized path template | `npm_config_prefix` (not the project/local prefix) |

Lowercase variable names take precedence, with uppercase fallback. Missing values
remain `absent`; defaults are not inferred from `NODE_ENV`, OS defaults, the current
directory or another npm config key. Explicit empty omit is `[]` with `ok`; empty
global-install and path values are `absent`. Omit accepts comma/whitespace/newline
separators, and rejects unknown categories. It describes the exposed omit setting,
not the final dependency set after other include/exclude options.

Lifecycle and command names accept up to 128 ASCII alphanumeric, colon, underscore
or hyphen characters, starting with an alphanumeric character. Malformed values
yield `error`. Manager identity is an environment-derived observation, not verified
binary provenance; a custom/spoofed user agent can affect it. Unknown identities or
unusable versions are `absent`. A user-agent identity takes precedence over the
executable fallback, and later compatibility-product tokens are ignored.

Absolute config paths use the shared path normalizer. Relative paths retain only
`<relative>`, `.`/`..` and `<dir>` components without guessing which caller directory
they resolve against. A bare script-shell command is `<command>`; Windows
drive-relative paths such as `C:cache` are `unsupported`. Input values are bounded
at 64 KiB of characters; oversize values yield `truncated`/`null`. Only the registry URL is additionally inspected for a hostname class; authentication,
token, and unrelated npm configuration variables are not inspected.

Environment exposure varies by package-manager version. See the
[npm configuration documentation](https://docs.npmjs.com/cli/v11/using-npm/config/)
and [lifecycle documentation](https://docs.npmjs.com/cli/v11/using-npm/scripts/).

The additional installation-context properties are:

| Property | Source / output |
| --- | --- |
| npm user-config normalized path template | `npm_config_userconfig`, using the config path normalizer; no file contents are read |
| npm registry hostname class with user information removed | `npm_config_registry`, parsed as HTTP(S); only `npm_public`, `localhost`, `ipv4`, `ipv6`, `single_label`, or `dns_name` is stored |
| npm user-agent normalized runtime components | `npm_config_user_agent`, reduced to `{ products, platform, architecture }` |
| INIT_CWD normalized path template | Absolute `INIT_CWD`, using the shared path normalizer |
| Lifecycle working-directory relation to INIT_CWD | Lexical relation of `process.cwd()` to `INIT_CWD`: `same`, `descendant`, `ancestor`, or `unrelated` |
| Package installation depth beneath node_modules | Number of enclosing `node_modules` path components in normalized cwd; zero is a valid result |

Registry classification retains no hostname, credentials, port, URL path, query, or
fragment. `npm_public` means exactly `registry.npmjs.org` (case-insensitive, allowing
a trailing DNS dot), not a hostname merely containing that text. IP classes do not
claim public/private routability. `localhost` also covers `.localhost` names. No
DNS lookup or registry request occurs. Missing URLs are `absent`; malformed or
non-HTTP(S) URLs yield `error` without retaining their text.

User-agent products are limited to npm, pnpm, Yarn, Bun and Node, with the first
valid occurrence of each retained in input order. Versions retain only numeric
major/minor/patch components, dropping prerelease/build text. Platform and
architecture tokens use fixed allowlists; missing components are `null`, unknown
tokens are discarded, and an entirely unrecognized agent is `absent`. This
property describes the supplied agent, not independently measured runtime facts.

Directory comparison occurs before redaction, preventing two private directories
from appearing equal just because they share a template. It follows POSIX or
Windows lexical path rules (including Windows case-insensitive comparison), without
resolving symlinks or checking directory existence. Different Windows roots are
`unrelated`. Missing `INIT_CWD` is `absent`; relative input is `error`. The depth
probe works independently of `INIT_CWD` and counts only `node_modules` components
with a following path component. Scopes do not add depth; pnpm store nesting does.
This is syntactic directory nesting, not a dependency-graph depth or proof of
installation provenance. All new environment inputs use the existing 64 KiB limit.

## Ancestor project and package-manager state

Eleven probes walk lexically upward from the package's installation cwd, checking at
most **16 directory levels including cwd**. Levels inside or equal to a
`node_modules` directory are skipped but still consume the depth budget. This
avoids reporting the probe package's own manifest or manifests of enclosing
dependencies, including scoped and pnpm store packages. When cwd is outside
`node_modules` (such as a root-project install), cwd itself is eligible.

The presence probes check regular files named `package-lock.json`,
`npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, and `package.json`, plus
directories named `.git` and `node_modules`. Presence means found at **any eligible
level** in the bounded walk; markers need not all belong to the same project root.
Only stat metadata is read for these probes, never lockfile contents or directory
listings. Stat follows symlinks; a `.git` worktree pointer file does not count as
a `.git` directory. Symlinked package cwd paths are inspected as exposed by Node;
the collector does not reconstruct a different consuming project's ancestry.

A found marker is `true`/`ok`. A fully searched path to the filesystem root with
no match is `false`/`ok`. If the depth budget is exhausted, the result is
`null`/`truncated`; inaccessible locations retain `permission_denied`, `timeout`,
or `error` instead of being reported as missing. A positive result may be found
before the depth limit without claiming the rest of the tree was searched.

The dependency probes read only the **nearest eligible regular `package.json`**,
bounded at 256 KiB. They return the number of own entries in `dependencies` and
`devDependencies` separately. Missing maps count as zero; optional and peer
dependencies are not added to the direct count. Missing manifests give `absent`.
Malformed JSON causes `error`, oversized input causes `truncated`, and invalid
dependency maps cause `error` for that map without masking a valid other map. No
fallback to a farther manifest occurs after a nearest-manifest read or parse error.

Stats and derived counts are cached within a collection only. Package names,
dependency versions, scripts, raw directory paths, and other manifest contents
are not included in reports, and no project code is executed. These observations
describe the tree visible at hook time; npm may write or update lockfiles and
manifests later in the installation.

Workspace presence checks each eligible ancestor for a regular
`pnpm-workspace.yaml` (metadata only) or a `package.json` containing a `workspaces`
array of strings or an object with a `packages` array of strings. Empty arrays
count as configuration. Parsed manifest observations are shared with dependency
counts; malformed/unreadable manifests retain their failure status. Ancestor
`.npmrc` presence checks metadata only, never contents.

Six user-level probes inspect fixed conventional paths beneath `os.homedir()`:

| Source | Linux | macOS | Windows |
| --- | --- | --- | --- |
| User config | `.npmrc` | `.npmrc` | `.npmrc` |
| npm cache | `.npm` | `.npm` | `AppData/Local/npm-cache`, then `.npm` |
| Yarn cache | `.cache/yarn` | `Library/Caches/Yarn`, then `.cache/yarn` | `AppData/Local/Yarn/Cache` |
| pnpm store | `.local/share/pnpm/store`, then `.pnpm-store` | `Library/pnpm/store`, then `.pnpm-store` | `AppData/Local/pnpm/store`, then `.pnpm-store` |

These are conventional-location observations, not effective configuration discovery.
Custom npm/Yarn/pnpm settings, XDG overrides and project-local caches are not
resolved. Other platforms return `unsupported`. Candidates are tried in order;
the first matching directory is selected, and access errors are not treated as
absence. Stats follow symlinks, as for ancestor markers.

The npm cache count includes all immediate entries in the selected cache. The log
count includes only regular-file directory entries in its `_logs` child, excluding
symlinks and directories. Neither count recurses or reads file contents. Directory
iteration inspects at most **1,024 entries**, including non-files for the log
budget, with a one-entry read buffer. Reaching the bound returns `null`/`truncated`
(even when exactly 1,024 entries exist). Empty directories return zero; missing
directories yield `absent` for counts and false for presence. Handles close on
completion, errors and cancellation once pending I/O returns. Raw paths, entry
names and `.npmrc` contents are never reported.

## Tool availability

Five probes search PATH without executing tools, invoking a shell, or listing
directories. Reports retain only boolean availability and status, never discovered
paths, file contents or version strings.

| Property | Known basenames |
| --- | --- |
| Git executable availability | `git` |
| Python executable availability | `python3`, `python` |
| Compiler executable availability | `cc`, `gcc`, `clang`, `c++`, `g++`, `clang++`, `cl` |
| Make executable availability | `make`, `gmake`, `nmake`, `mingw32-make` |
| Docker executable availability | `docker` |

POSIX candidates must be regular files with at least one execute mode bit and
pass `fs.access(X_OK)`. Stat follows symlinks; directories and dangling symlinks
do not match. Windows candidates use fixed `.exe`, `.com`, `.cmd`, `.bat`
suffixes and regular-file metadata, without a POSIX execute-bit check. Windows
PATH keys are matched case-insensitively, with exact `PATH` preferred, and paired
double quotes around entries are removed. Custom `PATHEXT` suffixes, shell
aliases/functions, version-suffixed tools and tools outside PATH are not searched.
These observations do not guarantee a tool can launch, a compiler works, or the
Docker daemon is available.

PATH input is bounded at 64 KiB of characters and at most 128 entries per group.
Empty and relative entries resolve against installation cwd; duplicate directories
are searched once per group. Windows drive-relative entries such as `C:tools`
are `unsupported` unless another entry supplies a match. No implicit cwd or
system search directories are added. Missing PATH yields `absent`; an explicitly
empty PATH searches cwd. Invalid input yields `error`.

An observed match returns true even if earlier candidates were inaccessible.
A complete search without a match returns false. If a candidate check failed,
the first failure status is retained when no match is found. Otherwise exhausting
the entry budget yields `null`/`truncated`, avoiding a false absence claim. Existing
probe deadlines and abort checks bound asynchronous searches. PATH is sampled
once per collection; filesystem observations can change during installation.

## Environment and CI indicators

Twenty-five probes report environment-variable count, three PATH properties, and
presence of `CI`, `GITHUB_ACTIONS`, `GITLAB_CI`, `JENKINS_URL`, `BUILDKITE`,
`CIRCLECI`, `TF_BUILD`, `TEAMCITY_VERSION`, `CODEBUILD_BUILD_ID`,
`BITBUCKET_BUILD_NUMBER`, `AWS_EXECUTION_ENV`, `KUBERNETES_SERVICE_HOST`, and
`SSH_AUTH_SOCK`, `LD_PRELOAD`, `LD_AUDIT`, `DYLD_INSERT_LIBRARIES`,
`VIRTUAL_ENV`, `CONDA_PREFIX`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, and `HF_TOKEN`.
Credential flags indicate variable presence only, without checking validity or reading values. Environment-variable count
is `Object.keys(process.env).length`. Indicator flags test own-key presence only: empty
strings, `false`, and `0` still count as present. Values (including build IDs, Jenkins URLs, service hosts and socket paths)
are never read or retained. These are indicators, not proof of execution in CI
or a container. SSH agent availability is not verified; no socket is contacted. Loader-variable
presence does not establish that a library was loaded; their values and referenced
files are never inspected.
Windows key matching is case-insensitive; POSIX key matching is case-sensitive.

PATH uses the platform delimiter (`:` or `;`), with exact `PATH` preferred over
other Windows key casing. Entry count includes duplicates and empty entries; an
explicitly empty PATH has one entry, while unset PATH yields `absent` for all
three PATH properties. Windows paired quotes are removed. No shell expansion,
command execution, directory listing or file-content read occurs.

Normalized categories form an array in PATH order, including duplicates, using
this fixed vocabulary and precedence:

| Category | Meaning |
| --- | --- |
| `current_directory` | Empty entry or literal `.` |
| `relative` | Other non-absolute entries |
| `node_modules_bin` | Normalized absolute path ending in `node_modules/.bin` |
| `windows_system` | Conventional Windows root, System32 or SysWOW64 paths |
| `system_bin` | POSIX `/bin`, `/sbin`, `/usr/bin`, `/usr/sbin`, `/usr/local/bin`, `/usr/local/sbin` |
| `user_directory` | Conventional POSIX `/home`, `/Users`, `/root` trees or Windows drive-rooted `Users` trees |
| `other_absolute` | Other absolute entries |

Categories are lexical heuristics independent of existence or access permissions;
private names, drive letters, and server names never appear in the array.

Nonexistent-entry count counts entries that do not resolve to directories,
including regular files and broken symlinks. Stat follows symlinks. Empty and
relative entries resolve against installation cwd; duplicate directories are
checked once but missing duplicates each contribute to the count. Access failures
retain their status rather than counting as missing. Windows drive-relative
entries such as `C:tools` yield `unsupported` for this count.

PATH input is bounded at 64 KiB of characters. Entry count remains exact within
that input bound. Categories retain at most 128 entries with `truncated` when
more exist; nonexistent-entry count returns `null`/`truncated` without filesystem
checks when more than 128 entries exist. Malformed PATH input yields `error`.
Existing per-probe deadlines and abort checks apply. Derived environment metadata
and parsed PATH are cached only within each collection.

## Container markers, cgroups and namespaces

Seven probes add the following observations. Filesystem probes are Linux-only;
other platforms return `unsupported`. Environment presence works on all platforms.

| Property | Source and representation |
| --- | --- |
| Docker marker-file presence | Regular-file metadata for `/.dockerenv` |
| Podman container marker-file presence | Regular-file metadata for `/run/.containerenv` |
| Container environment-variable presence | Boolean own-key presence of any of `container`, `CONTAINER`, `KUBERNETES_SERVICE_HOST`; Windows matching ignores case |
| Cgroup version | `v1`, `v2`, or `hybrid` from visible `/proc/self/cgroup` membership rows |
| Cgroup controller list | Sorted unique allowlisted v1 membership controllers plus v2 controllers available at the current group's resolved `cgroup.controllers` |
| Cgroup path normalized template | Ordered unique array of redacted membership paths; filesystem root remains `/` |
| Visible namespace type list | Sorted unique types from fixed `/proc/self/ns` symlink metadata |

Marker checks follow symlinks but never read contents. Missing markers return
false; access failures retain their status. The environment probe never reads
values. These markers and flags are observations, not proof of a particular
runtime or isolation boundary; `/run/.containerenv` may be used by other tools.

Cgroup input is bounded at 64 KiB and 128 membership rows, with at most 128 path
components per row. Empty membership yields `absent`. Malformed rows or traversal
components yield `error`. Paths retain only `system.slice`, `user.slice`,
`machine.slice`, `docker`, `kubepods`, `kubepods.slice`, `burstable`, `besteffort`,
and `init.scope`; every other component becomes `<group>`. User IDs, container IDs,
service names, and custom named hierarchies are not reported.

V2 controller discovery reuses the mount-aware resource resolver and reads
`/proc/self/mountinfo` with a 1 MiB bound. It handles nonstandard mount points and
visible namespace roots instead of assuming `/sys/fs/cgroup` is the current group.
An unavailable controller source does not erase version or path observations.
The list contains recognized kernel controller names only; custom `name=`
hierarchies and unknown names are discarded. It describes visible v1 membership
and v2 controllers available for delegation, not enabled controllers or effective
resource limits. See the [kernel cgroup v2 documentation](https://cdn.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

Namespace probing checks exactly ten names: `cgroup`, `ipc`, `mnt`, `net`, `pid`,
`pid_for_children`, `time`, `time_for_children`, `user`, and `uts`. Child aliases
collapse to `pid` and `time`. Only symlink metadata is inspected; targets and inode
IDs are never read or retained, and no directory listing occurs. Missing namespace
directories yield `absent`; existing directories with no known links yield `[]`.
The list does not establish namespace isolation or nesting depth, so `NSpid` is
not read for this property. See [Linux namespaces documentation](https://man7.org/linux/man-pages/man7/namespaces.7.html).

Reads are cached within each collection only and use the existing deadlines and
abort signals. No commands, container APIs, or namespace-changing operations run.

## Process and security observations

Ten Linux-only probes use procfs; other platforms return `unsupported`.

| Property | Representation |
| --- | --- |
| PID namespace nesting depth when exposed | Number of `NSpid` values minus one; zero means no additional nesting visible from this procfs mount |
| PID 1 executable basename | Basename from `/proc/1/exe`, with bounded `comm` fallback |
| Visible process count | Number of numeric directory entries in a bounded `/proc` scan |
| Parent process executable basename | Basename for the `PPid` in `/proc/self/status` |
| Bounded ancestor-process executable basename sequence | Ordered array starting with the immediate parent, walking `PPid` to zero |
| Process executable allowlist matches for analysis tooling | Sorted unique exact allowlist matches among processes from the bounded `/proc` scan |
| Own process tracer status | Boolean `TracerPid != 0`; tracer PID is discarded |
| Own process seccomp mode | Numeric `0` (disabled), `1` (strict), or `2` (filter) |
| Own process NoNewPrivs status | Boolean from `NoNewPrivs`: `0` is false, `1` is true |
| Own process effective capability mask | `CapEff` as a lowercase 16-digit hexadecimal string, without `0x` |

`NSpid` exposes nesting relative to the procfs mount's PID namespace, not necessarily
the host's namespace. It is bounded at 32 entries. Missing status fields yield
`absent`; malformed fields yield `error` independently. Status reads accept at
most 64 KiB and retain only selected fields in the collection cache. All own
status probes share one read. Capability masks accept 1–16 hex digits and are
zero-padded to 16 digits, preserving all 64 bits without numeric conversion.
Invalid or duplicate fields yield `error`; zero values are valid observations. See the
[Linux process-status documentation](https://man7.org/linux/man-pages/man5/proc_pid_status.5.html).

Executable paths come from symlink metadata, never executable file contents or
argv. Targets over 4 KiB yield `truncated`; the kernel's ` (deleted)` suffix is
removed before deriving the basename. Missing or denied executable links fall
back to `/proc/<pid>/comm`, read with a 256-byte bound. This fallback is a mutable
process name, not verified executable identity. Names at or above the kernel's
15-byte comm boundary are marked `truncated` and excluded from exact allowlist
matches. See [proc executable links](https://man7.org/linux/man-pages/man5/proc_pid_exe.5.html)
and [process comm names](https://man7.org/linux/man-pages/man5/proc_pid_comm.5.html).

The process scan inspects at most 1,024 total entries, including nonnumeric entries,
using a one-entry buffer. Reaching that bound yields `null`/`truncated` for count,
even when exactly 1,024 entries exist. Handles close on completion, errors and
cancellation once pending I/O returns. The ancestor walk stops at 16 parents;
cycles produce `error`. Partial ancestor arrays retain the failure or truncation
status. Zero `PPid` gives an absent parent and an empty ancestor sequence.

The fixed research allowlist is `bpftrace`, `gdb`, `lldb`, `ltrace`, `perf`, `rr`,
`strace`, `sysdig`, `tcpdump`, `tshark`, and `valgrind`. Matching is exact and
case-sensitive. Only matches are reported, with a non-`ok` status if enumeration
or any inspected basename was incomplete. Matches do not prove active tracing,
and absence does not rule out analysis tools. No behavior changes based on these
observations. No commands, ptrace operations, socket calls or security changes run.

Process names and status observations are shared within a collection only.
Visibility depends on procfs permissions and namespaces; process exit, reparenting,
exec and PID reuse can race collection. These results are not an atomic process
snapshot or a host-wide process inventory.

## Filesystem metadata

Seven metadata probes use asynchronous `fs.statfs(path, { bigint: true })` for installation cwd,
`os.homedir()` and `os.tmpdir()`. Calls follow filesystem path resolution, including
symlinks. Each distinct path is sampled once per collection; cwd statistics are
shared across its five properties. No directory listing, file-content read or
external command is used, and raw paths are not reported.

| Property | Representation |
| --- | --- |
| Working / home / temporary filesystem type | Known Linux type name, otherwise a platform-qualified hexadecimal identifier such as `darwin:0x1a` |
| Working-filesystem total bytes | `blocks × bsize` |
| Working-filesystem available bytes | `bavail × bsize`, using caller-available blocks rather than all free blocks |
| Working-filesystem inode capacity | `files`, the reported total inode capacity |
| Working-filesystem available inode count | `ffree`, the reported free inode count; Node does not expose a separate caller-available inode field |

Products are calculated with BigInt. Values within JavaScript's safe integer range
are JSON numbers; larger values are exact decimal strings. Zero is retained.
Invalid fields fail independently. Unavailable APIs or fields return `unsupported`;
missing paths, denied access and deadlines retain their usual statuses. Input paths
are bounded at 64 KiB of characters. Native statfs calls cannot be cancelled while
in flight, but timeout results are enforced and late results are discarded.

Linux type names use a fixed magic-number mapping for ext, btrfs, xfs, tmpfs,
overlay, nfs, fuse, cifs, smb2, proc, sysfs, ramfs, squashfs, fat and ntfs. `ext`
deliberately groups ext2/ext3/ext4 because their magic is shared. Unknown types
retain an exact platform-qualified ID; non-Linux IDs are not interpreted as Linux
magic numbers. Numeric type zero is `unsupported`. Windows type and inode capacity
are `unsupported` because libuv supplies zero placeholders for them; byte
capacities remain available. Inode sentinel values of -1 or unsigned 64-bit maximum
also return `unsupported`.

These statistics describe the visible filesystem at collection time, not physical
disk size, guaranteed writable capacity, or an inode quota. Mounts and available
space can change between observations. See the [Node statfs API](https://nodejs.org/api/fs.html#fspromisesstatfspath-options),
[Linux filesystem magic values](https://man7.org/linux/man-pages/man2/statfs.2.html),
and [libuv Windows statfs implementation](https://github.com/libuv/libuv/blob/v1.x/src/win/fs.c).

## Mounts and temporary-file checks

Four Linux probes share one `/proc/self/mountinfo` read, bounded at 1 MiB and
4,096 rows. Other platforms return `unsupported`. They report root read-only
status (either mount or superblock `ro`), exact `overlay` type presence, exact
`tmpfs` type count, and total mount-table row count. Stacked root mounts are
resolved through parent IDs; ambiguous roots return `unsupported`, and a missing
root returns `absent`. Counts describe the process's mount namespace, including
covered mounts, rather than a host-wide inventory. Empty input yields `absent`,
malformed input `error`, and exceeded bounds `truncated`; no partial counts or
mount paths are reported. See the [mountinfo format](https://man7.org/linux/man-pages/man5/proc_pid_mountinfo.5.html).

The two temporary-directory probes share one create/close/delete operation per
collection. The default approved location is `os.tmpdir()`. Set
`createFilesystemProbes({ approvedTempDirectory: '/approved/path' })` to use an
existing absolute directory, or pass `null` to disable both checks. No directories
are created and no fallback directory is tried. A random UUID filename is opened
with exclusive `wx` flags and mode `0600`; no contents are written. Only the file
created by that operation is deleted. Creation and deletion successes return
`true`/`ok`; failures return `null` with the existing error status. If creation
fails, deletion is unattempted and `absent`. Close failures mark creation as failed
but still attempt deletion. Paths and filenames are never reported.

Cleanup still runs if an in-flight open finishes after cancellation. Native file
operations cannot be forcibly cancelled; a denied deletion or process termination
can leave the empty probe file behind. These checks observe one operation at one
moment and do not guarantee later write access or available capacity.

## Filesystem and host-use artifacts

Eighteen probes in `createHostArtifactProbes()` observe access and metadata only.
The package-directory check calls asynchronous `fs.access(packageRoot, R_OK)`
against this module's package root, independent of installation cwd. Success is
`true`/`ok`; denied or unavailable access retains the usual `null`/error status.
This is an access observation, not a guarantee of subsequent file reads.

Home file and subdirectory counts share one top-level `opendir` scan. Hidden
entries are included, regular files and directories are counted separately, and
symlinks and special files contribute to neither type count. Configuration/cache
entry counts include every direct entry, including symlinks and special files.
There is no recursion, file-content read, shell execution, or reported filename.

These are fixed conventional locations, matching the approach used for the user
package-manager probes; environment overrides such as `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, `APPDATA`, `LOCALAPPDATA`, and `HISTFILE` are not resolved.

| Platform | Configuration directory | Cache directory |
| --- | --- | --- |
| Linux | `~/.config` | `~/.cache` |
| macOS | `~/Library/Application Support` | `~/Library/Caches` |
| Windows | `~/AppData/Roaming` | `~/AppData/Local` |

Windows Local AppData includes non-cache application data; its result describes
that conventional directory's entries, not a count of verified cache artifacts.
Configuration presence uses directory metadata. A missing/wrong-type directory
returns `false` for presence and `absent` for its count; an existing empty directory
returns zero. Named directory metadata follows symlinks, but scans do not traverse
symlink entries. Other platforms retain home/package observations and return
`unsupported` for configuration, cache, and history conventions.

Shell-history presence checks regular-file metadata for Linux/macOS
`~/.bash_history`, `~/.zsh_history`, `~/.sh_history`, `~/.history`, and
`~/.local/share/fish/fish_history`. Windows checks
`~/AppData/Roaming/Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt`
and `~/AppData/Roaming/Microsoft/PowerShell/PSReadLine/ConsoleHost_history.txt`.
A positive match returns `true`; a complete negative check returns `false`.
If a check fails and no other candidate matches, its error status is retained.
History contents are never opened. Custom history locations are outside this
bounded check, so a negative result does not establish absence of shell use.

Five developer-tooling presence probes use only `fs.stat` metadata at fixed paths
under `os.homedir()`. They never open files, enumerate these directories, invoke
tools, or read credentials. Linux, macOS and Windows use these candidates (`~`
denotes the home directory, with native path separators):

| Property | Linux/macOS | Windows | Required type |
| --- | --- | --- | --- |
| SSH directory | `~/.ssh` | `~/.ssh` | Directory |
| AWS configuration directory | `~/.aws` | `~/.aws` | Directory |
| Azure configuration directory | `~/.azure` | `~/.azure` | Directory |
| Google Cloud configuration directory | `~/.config/gcloud` | `~/AppData/Roaming/gcloud` | Directory |
| Git configuration file | `~/.gitconfig`, `~/.config/git/config` | Same home-relative candidates | Regular file |

The locations follow conventional [AWS](https://docs.aws.amazon.com/sdkref/latest/guide/file-location.html),
[Azure](https://learn.microsoft.com/en-us/cli/azure/azure-cli-configuration),
[Google Cloud](https://docs.cloud.google.com/sdk/docs/configurations), and
[Git](https://git-scm.com/docs/git-config) configuration locations. Environment
overrides and redirected Windows AppData locations are outside these fixed checks.
Other platforms return `unsupported`.

A matching type returns `true`/`ok`; missing paths or wrong types return
`false`/`ok`. Metadata follows symlinks, including links to targets outside home;
dangling links count as missing. Git stops on the first regular file. If one
candidate fails but another matches, the result is true; otherwise the first
failure's status is retained. Permission failures are not reported as absence.
Results contain no paths or contents. Presence does not establish installed
tooling, a configured account, or usable credentials.

Six additional editor/assistant directory probes use the same metadata-only
presence helper and status rules. Every candidate must be a directory; no
contents, product versions, sessions, settings or credentials are read. The
following paths are relative to home:

| Property | Linux | macOS | Windows |
| --- | --- | --- | --- |
| VS Code | `.config/Code`, `.config/Code - Insiders` | `Library/Application Support/Code`, `Library/Application Support/Code - Insiders` | `AppData/Roaming/Code`, `AppData/Roaming/Code - Insiders` |
| JetBrains | `.config/JetBrains` | `Library/Application Support/JetBrains` | `AppData/Roaming/JetBrains` |
| Cursor | `.config/Cursor`, `.cursor` | `Library/Application Support/Cursor`, `.cursor` | `AppData/Roaming/Cursor`, `.cursor` |
| Claude | `.claude` | `.claude` | `.claude` |
| GitHub Copilot | `.copilot`, `.config/github-copilot` | `.copilot`, `.config/github-copilot` | `.copilot`, `AppData/Local/github-copilot` |
| Gemini | `.gemini` | `.gemini` | `.gemini` |

The desktop paths follow [VS Code](https://code.visualstudio.com/docs/configure/settings),
[JetBrains](https://www.jetbrains.com/help/idea/directories-used-by-the-ide-to-store-settings-caches-plugins-and-logs.html),
and [Cursor](https://docs.cursor.com/en/troubleshooting/troubleshooting-guide)
conventions. The CLI candidates follow [Claude Code](https://code.claude.com/docs/en/settings),
[Copilot CLI](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-config-dir-reference),
and [Gemini CLI](https://geminicli.com/docs/reference/configuration/).

Claude and Gemini checks cover their CLI home directories, not desktop/browser
applications. Copilot checks include its CLI and conventional shared integration
directories, not every editor's extension storage. JetBrains checks only the
modern parent directory, without enumerating product/version directories or
searching legacy versioned locations. VS Code extension-only `.vscode` directories,
portable/remote installations, project-local directories, and environment or
command-line path overrides are outside these checks. A positive result is only
directory presence; a negative result is not proof a product has never been used.

Developer tooling directory probes use the following fixed paths relative to the
home directory on Linux, macOS, and Windows (with native separators):

| Property | Candidates |
| --- | --- |
| Hugging Face model-cache | `.cache/huggingface/hub`, `.cache/huggingface/transformers` |
| Ollama models | `.ollama/models` |
| Jupyter configuration | `.jupyter` |
| Conda installation | `miniconda3`, `anaconda3`, `miniforge3`, `mambaforge`, and their initial-capital variants (`Miniconda3`, `Anaconda3`, `Miniforge3`, `Mambaforge`) |

These checks use directory metadata only, follow symlinks, and never enumerate
or read contents. They return true for any matching directory, false when all
candidates are missing or the wrong type, and an error status when an incomplete
check prevents a negative conclusion. Paths are omitted from reports. Custom
locations, environment overrides, and system-wide installations are outside the
candidate set; presence does not verify an installation or cached model files.

Scans examine at most 1,024 entries with a one-entry directory buffer. Reaching
the bound, including exactly 1,024 entries, returns `null`/`truncated` without an
extra read or a partial count. Tests or callers may lower this bound using
`entryLimit`. Directory handles close on completion, failure, and cancellation
once pending I/O returns. Counts and metadata are cached within a collection only;
paths are bounded at 64 KiB and omitted from reports. Permission errors and races
retain the existing status semantics.

## Network configuration

Fourteen probes in `createNetworkProbes()` report counts, booleans and address
classes. Five
share one `os.networkInterfaces()` call per collection. Interface count counts
nonempty interface groups, not individual addresses; empty/undefined groups are
ignored. Non-loopback count counts groups with at least one `internal: false`
record. IPv4/IPv6 availability includes internal interfaces. Loopback-only is true
only when at least one interface is reported and every record is internal; an
empty snapshot returns zero counts and false booleans.

Node's `internal` flag covers loopback or similar interfaces that are not remotely
accessible. These properties describe assigned-address interfaces visible to Node,
not every physical or unconfigured adapter. Only family and internal flags are
inspected; names, IP addresses, MACs, netmasks and scope IDs are not cached or
reported. Processing is bounded at 1,024 groups and 4,096 address records. Unknown
families or malformed records yield `error`; unavailable APIs yield `unsupported`.
Numeric family values 4/6 are accepted alongside IPv4/IPv6 strings. See the
[Node network-interface API](https://nodejs.org/api/os.html#osnetworkinterfaces).

Default-route probes are Linux-only and read `/proc/net/route` and
`/proc/net/ipv6_route` independently, each with a 1 MiB / 4,096-row limit. IPv4
requires zero destination and mask; IPv6 requires the all-zero destination and
prefix length zero. Both require `RTF_UP` and exclude `RTF_REJECT`, including IPv6
unreachable placeholder entries. A gateway is not required. IPv6 source-specific
default routes also count. The complete bounded input is validated before a result
is returned. Empty IPv6 tables and header-only IPv4 tables return false; a missing
IPv4 header is `absent` for empty input and `error` for malformed input. Missing,
denied, malformed, oversized, and timed-out sources retain distinct statuses.

These are route-presence observations in the process's network namespace, not
connectivity tests. IPv4 proc output describes the main table; IPv6 can expose
multiple tables, without their policy rules. No policy-route selection, gateway
reachability, DNS lookup, socket connection or external request is performed.
The parsers follow the kernel's [IPv4 proc output](https://github.com/torvalds/linux/blob/master/net/ipv4/fib_trie.c)
and [IPv6 proc output](https://github.com/torvalds/linux/blob/master/net/ipv6/ip6_fib.c).
Only derived observations are cached, and later collections refresh them.

The two DNS resolver probes share one
[`dns.getServers()`](https://nodejs.org/api/dns.html#dnsgetservers) snapshot per
collection. Count includes every returned entry; address class is a sorted,
deduplicated array of `unspecified`, `loopback`, `private`, `link_local`, `shared`,
`multicast` and `other`. Empty lists return count zero and an empty class array.
Private covers IPv4 RFC 1918 and IPv6 unique-local ranges; shared covers
100.64.0.0/10. IPv4-mapped IPv6 addresses use the corresponding IPv4 ranges.
`other` is a fallback, not a claim of public routability. IPv4/IPv6 endpoints with
ports and IPv6 scope IDs are handled locally; addresses, ports and scope IDs are
never cached or reported. The list is bounded at 1,024 entries and each entry at
1,024 characters. Invalid entries yield `error`; missing APIs yield `unsupported`.
These settings describe Node's DNS resolver, which can differ from OS lookup
configuration. No DNS requests are sent.

Search-domain count reads only `/etc/resolv.conf` on Linux, macOS, FreeBSD,
OpenBSD, NetBSD, SunOS and AIX; other platforms return `unsupported`. The file is
bounded at 64 KiB and 4,096 lines. Following
[`resolv.conf` directives](https://man7.org/linux/man-pages/man5/resolv.conf.5.html),
the final `search` or `domain` directive determines the count; `domain` requires
exactly one entry. Comments beginning with `#` or `;` are ignored. No directive
or an empty `search` yields zero. Missing files yield `absent`, rather than zero;
other source failures retain their standard statuses. This counts explicit file
entries only, not hostname-derived defaults, `LOCALDOMAIN` overrides, or platform
per-interface/split-DNS configuration. Domain values never enter results or caches.

`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` probes return true when
either the uppercase or lowercase environment key exists, including an empty
value. They inspect key presence without reading values. Presence does not imply
the proxy is enabled, valid or used by a particular HTTP client.

## Timezone and locale

Six probes in `createLocaleProbes()` report the literal `TZ`, `LANG` and `LC_ALL`
environment values, the runtime-resolved timezone and locale identifiers, and the
current timezone offset in minutes. Missing environment keys return `absent`;
present empty strings return `ok` with an empty value. Values are not trimmed,
interpreted or normalized, and strings exceeding 4,096 characters are truncated
with status `truncated`. Only the three requested environment keys are read.

The two resolved identifiers share one `Intl.DateTimeFormat().resolvedOptions()`
snapshot per collection. A later collection takes a new snapshot. These reflect
runtime defaults and may differ from the environment values; no locale precedence
or timezone identifier is inferred from those variables. Missing Intl APIs return
`unsupported`, missing identifiers return `absent`, and malformed values return
`error` without preventing independent probes from running.

The offset comes from `new Date().getTimezoneOffset()` at collection time, using
JavaScript's UTC-minus-local sign: Colombo is `-330`, while New York is `300` in
standard time and `240` during daylight saving time. It is date-dependent, not a
timezone's fixed standard offset. Invalid dates or non-integer offsets return
`error`. Probes do not change environment variables, runtime locale or timezone.

## Bounds and restricted environments

Probes run sequentially with a 1.5-second deadline each and an abort signal for I/O.
OS release reads accept only regular files and at most 64 KiB; oversized files yield
`truncated` with `null`. String values are capped at 4,096 JavaScript code units.
macOS invokes the fixed `/usr/bin/sw_vers` executable without a shell, with a
one-second timeout and 4 KiB output limit. Native Node methods require no external
utilities. A failed probe does not prevent the remaining probes from running.

The standalone installation script has a 30-second event-loop watchdog and exits
successfully after logging failures so research collection does not fail the package
installation. Timers cannot interrupt a synchronously blocked native call. If all
output directories are unwritable, the process is terminated externally, or the
watchdog fires before persistence, no complete report is guaranteed. Preserve the
chosen report directory as a CI/scanner artifact before the environment is removed.
There is no network reporting.

## Development

```sh
npm test
npm run example
npm run pack:check
```

The example/API allows explicit manual collection for development; it does not label
those snapshots as installation evidence. Only the lifecycle wrapper adds `phase`
and `package`. Tests cover mocked Linux/macOS/Windows/restricted environments,
status handling, bounds, and an offline packed-package install/rebuild/ignore-scripts
cycle. Native platform coverage depends on the OS running the tests.

```text
catalog/                  Original 200-property CSV
scripts/postinstall.js    Installation hook and output selection
src/catalog.js            Catalog reader
src/collect.js            Property-level collection and timeouts
src/result.js             Status vocabulary and error mapping
src/report.js             JSON persistence and directory fallback
src/probes/os-machine.js  Ten OS/machine probes
src/probes/os-release.js  Bounded Linux metadata reader/parser
src/probes/cpu.js         Nine CPU probes and bounded cpuinfo parser
src/probes/resources.js   Memory, cgroups and process resource limits
src/probes/session.js     Derived user/host data, paths and session properties
src/probes/runtime.js     Node versions, startup flags and normalized runtime paths
src/probes/installation.js  Sanitized package-manager and npm configuration metadata
src/probes/project.js     Bounded ancestor markers, workspaces and dependency counts
src/probes/user-package.js  User package-manager presence and bounded counts
src/probes/tools.js       Bounded PATH searches for tool availability
src/probes/environment.js  Environment counts, PATH categories and CI indicators
src/probes/container.js   Container markers, cgroup metadata and namespace types
src/probes/process-state.js  Bounded process ancestry, tool matches and security state
src/probes/filesystem.js  Filesystem statistics, mount observations and temporary-file checks
src/probes/host-artifacts.js  Package access and bounded home/configuration/cache/history metadata
src/probes/network.js     Interface/route aggregates, DNS configuration and proxy presence
src/probes/locale.js      Timezone/locale environment values, runtime identifiers and UTC offset
test/                     Unit and packed-install integration tests
examples/collect.js       Explicit development snapshot
```

To add a probe, use an exact catalog label and return `{ value, status }` from
`run({ signal })`. Register it in `src/probes/index.js`. `collectEnvironment({
probes, timeoutMs })` accepts an explicit probe list that replaces the defaults;
unselected properties remain `disabled`. Custom asynchronous probes must honor
the signal and release their own resources. Do not perform unbounded synchronous
work in a probe.
# environment-fingerprinting
