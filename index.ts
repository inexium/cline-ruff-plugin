/**
 * Cline plugin: Ruff tools for Python.
 *
 * Registers two tools the Cline agent can call:
 *   - ruff_check  : lint Python files (or a code snippet) with `ruff check`,
 *                   optionally applying auto-fixes.
 *   - ruff_format : format Python files (or a code snippet) with `ruff format`,
 *                   or only report / diff what would change.
 *
 * Ruff itself must be installed on the machine (`pip install ruff`, `uv tool
 * install ruff`, `brew install ruff`, ...). Set RUFF_PATH to point to a
 * specific binary; otherwise `ruff` is looked up on PATH.
 *
 * Install:  cline plugin install <git url | npm package | local path>
 */
import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";
import { createTool } from "@cline/sdk";
import type { AgentPlugin, AgentToolContext } from "@cline/sdk";

type PluginSetup = NonNullable<AgentPlugin["setup"]>;
type PluginSetupApi = Parameters<PluginSetup>[0];
type PluginSetupContext = Parameters<PluginSetup>[1];

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_CHARS = 1_000_000;

interface RunResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

class RuffNotFoundError extends Error {
	constructor(binary: string) {
		super(
			`Ruff executable "${binary}" was not found. Install Ruff (e.g. "pip install ruff", ` +
				`"uv tool install ruff" or "brew install ruff") or set the RUFF_PATH environment ` +
				`variable to the ruff binary.`,
		);
		this.name = "RuffNotFoundError";
	}
}

function ruffBinary(): string {
	return process.env.RUFF_PATH?.trim() || "ruff";
}

function runRuff(
	args: string[],
	options: { cwd: string; stdin?: string; signal?: AbortSignal },
): Promise<RunResult> {
	const binary = ruffBinary();
	return new Promise((resolvePromise, reject) => {
		const child = spawn(binary, args, {
			cwd: options.cwd,
			// "concise" makes `ruff format --check` list one file per line on Ruff >= 0.16;
			// `ruff check` always gets an explicit --output-format json.
			env: { ...process.env, NO_COLOR: "1", RUFF_OUTPUT_FORMAT: "concise" },
			stdio: ["pipe", "pipe", "pipe"],
			signal: options.signal,
			timeout: DEFAULT_TIMEOUT_MS,
			windowsHide: true,
		});

		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (stdout.length < MAX_OUTPUT_CHARS) stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			if (stderr.length < MAX_OUTPUT_CHARS) stderr += chunk;
		});

		child.on("error", (error: NodeJS.ErrnoException) => {
			if (error.code === "ENOENT") reject(new RuffNotFoundError(binary));
			else reject(error);
		});
		child.on("close", (code, signal) => {
			if (code === null) {
				reject(new Error(`ruff was terminated (${signal ?? "unknown signal"}).`));
				return;
			}
			resolvePromise({ stdout, stderr, exitCode: code });
		});

		// Ignore EPIPE if ruff exits before reading all of stdin.
		child.stdin.on("error", () => {});
		child.stdin.end(options.stdin ?? "");
	});
}

/** Ruff exits with 2 on usage errors, bad config, internal errors... */
function failIfRuffError(result: RunResult, what: string): void {
	if (result.exitCode >= 2) {
		const details = (result.stderr || result.stdout).trim();
		throw new Error(`${what} failed (exit code ${result.exitCode}): ${details || "no output"}`);
	}
}

// ---------------------------------------------------------------------------
// Shared input handling
// ---------------------------------------------------------------------------

interface CommonInput {
	paths?: string[];
	code?: string;
	filename?: string;
	cwd?: string;
	config?: string;
}

function resolveCwd(input: CommonInput, ctx: AgentToolContext, setup: PluginSetupContext): string {
	const base = ctx.cwd ?? setup.cwd ?? setup.workspaceInfo?.rootPath ?? process.cwd();
	if (!input.cwd) return base;
	return isAbsolute(input.cwd) ? input.cwd : resolve(base, input.cwd);
}

function targetPaths(input: CommonInput): string[] {
	const paths = (input.paths ?? []).map((p) => p.trim()).filter(Boolean);
	if (paths.length === 0) return ["."];
	for (const p of paths) {
		if (p.startsWith("-")) throw new Error(`Invalid path "${p}": paths must not start with "-".`);
	}
	return paths;
}

function configArgs(input: CommonInput): string[] {
	return input.config ? ["--config", input.config] : [];
}

function stdinArgs(input: CommonInput): string[] {
	return ["--stdin-filename", input.filename || "snippet.py", "-"];
}

function usesSnippet<T extends CommonInput>(input: T): input is T & { code: string } {
	return typeof input.code === "string";
}

const commonSchemaProperties = {
	paths: {
		type: "array",
		items: { type: "string" },
		description:
			'Files or directories to process, relative to the working directory. Defaults to ["."] (the whole project). Ignored when "code" is given.',
	},
	code: {
		type: "string",
		description:
			"Python source code to process instead of files on disk (passed to Ruff via stdin). Nothing is written to disk in this mode.",
	},
	filename: {
		type: "string",
		description:
			'Virtual filename used for the "code" snippet, so Ruff applies the right per-file settings (e.g. "src/app/models.py" or "notebook.pyi"). Defaults to "snippet.py".',
	},
	cwd: {
		type: "string",
		description:
			"Directory to run Ruff from (Ruff discovers pyproject.toml / ruff.toml from here). Defaults to the session working directory.",
	},
	config: {
		type: "string",
		description:
			'Path to a Ruff config file, or an inline TOML override such as "line-length = 100".',
	},
} as const;

// ---------------------------------------------------------------------------
// ruff_check
// ---------------------------------------------------------------------------

interface RuffCheckInput extends CommonInput {
	fix?: boolean;
	unsafe_fixes?: boolean;
	select?: string[];
	ignore?: string[];
	extend_select?: string[];
	max_diagnostics?: number;
}

/** Shape of one entry of `ruff check --output-format json`. */
interface RuffJsonDiagnostic {
	code: string | null;
	name?: string;
	message: string;
	filename: string;
	location: { row: number; column: number } | null;
	end_location: { row: number; column: number } | null;
	fix: { applicability: "safe" | "unsafe" | "display-only"; message: string | null } | null;
	url: string | null;
	severity?: string;
}

interface Diagnostic {
	file: string;
	line: number | null;
	column: number | null;
	end_line: number | null;
	end_column: number | null;
	code: string | null;
	message: string;
	fixable: "safe" | "unsafe" | null;
	fix_message: string | null;
	url: string | null;
}

function ruleArgs(input: RuffCheckInput): string[] {
	const args: string[] = [];
	const list = (flag: string, values?: string[]) => {
		const cleaned = (values ?? []).map((v) => v.trim()).filter(Boolean);
		if (cleaned.length > 0) args.push(flag, cleaned.join(","));
	};
	list("--select", input.select);
	list("--extend-select", input.extend_select);
	list("--ignore", input.ignore);
	return args;
}

function parseDiagnostics(stdout: string, cwd: string, snippetName?: string): Diagnostic[] {
	const text = stdout.trim();
	if (!text) return [];
	let raw: RuffJsonDiagnostic[];
	try {
		raw = JSON.parse(text) as RuffJsonDiagnostic[];
	} catch {
		throw new Error(`Could not parse Ruff JSON output: ${text.slice(0, 500)}`);
	}
	return raw.map((d) => ({
		file: snippetName ?? (relative(cwd, d.filename) || d.filename),
		line: d.location?.row ?? null,
		column: d.location?.column ?? null,
		end_line: d.end_location?.row ?? null,
		end_column: d.end_location?.column ?? null,
		code: d.code,
		message: d.message,
		fixable:
			d.fix && (d.fix.applicability === "safe" || d.fix.applicability === "unsafe")
				? d.fix.applicability
				: null,
		fix_message: d.fix?.message ?? null,
		url: d.url,
	}));
}

function countByRule(diagnostics: Diagnostic[]): Record<string, number> {
	const counts: Record<string, number> = {};
	for (const d of diagnostics) {
		const key = d.code ?? "syntax-error";
		counts[key] = (counts[key] ?? 0) + 1;
	}
	return Object.fromEntries(Object.entries(counts).sort((a, b) => b[1] - a[1]));
}

async function ruffCheck(input: RuffCheckInput, ctx: AgentToolContext, setup: PluginSetupContext) {
	const cwd = resolveCwd(input, ctx, setup);
	const snippet = usesSnippet(input);
	const snippetName = snippet ? input.filename || "snippet.py" : undefined;
	const base = ["check", "--no-fix", "--output-format", "json", ...configArgs(input), ...ruleArgs(input)];
	if (input.unsafe_fixes) base.push("--unsafe-fixes");
	const targets = snippet ? stdinArgs(input) : ["--", ...targetPaths(input)];

	const lint = async (source?: string) => {
		const result = await runRuff([...base, ...targets], { cwd, stdin: source, signal: ctx.signal });
		failIfRuffError(result, "ruff check");
		return parseDiagnostics(result.stdout, cwd, snippetName);
	};

	let before: Diagnostic[] | undefined;
	let fixedCode: string | undefined;
	if (input.fix) {
		before = await lint(input.code);
		const fixArgs = ["check", "--fix", "--silent", "--exit-zero", ...configArgs(input), ...ruleArgs(input)];
		if (input.unsafe_fixes) fixArgs.push("--unsafe-fixes");
		const fixResult = await runRuff([...fixArgs, ...targets], { cwd, stdin: input.code, signal: ctx.signal });
		failIfRuffError(fixResult, "ruff check --fix");
		if (snippet) fixedCode = fixResult.stdout;
	}

	const remaining = await lint(snippet ? (fixedCode ?? input.code) : undefined);
	const limit = Math.max(1, Math.floor(input.max_diagnostics ?? 200));
	const fixableSafe = remaining.filter((d) => d.fixable === "safe").length;
	const fixableUnsafe = remaining.filter((d) => d.fixable === "unsafe").length;

	let summary: string;
	if (remaining.length === 0) {
		summary = input.fix ? `All issues fixed (${before?.length ?? 0} fixed).` : "No issues found.";
	} else {
		summary = `${remaining.length} issue(s) ${input.fix ? "remaining" : "found"}`;
		if (input.fix) summary += ` (${Math.max(0, (before?.length ?? 0) - remaining.length)} fixed)`;
		summary += ".";
		if (!input.fix && fixableSafe > 0) summary += ` ${fixableSafe} can be fixed automatically with fix=true.`;
		if (fixableUnsafe > 0 && !input.unsafe_fixes)
			summary += ` ${fixableUnsafe} more have unsafe fixes (fix=true, unsafe_fixes=true).`;
	}

	return {
		summary,
		cwd,
		target: snippet ? snippetName : targetPaths(input),
		fixed: input.fix ? Math.max(0, (before?.length ?? 0) - remaining.length) : 0,
		total: remaining.length,
		fixable: { safe: fixableSafe, unsafe: fixableUnsafe },
		by_rule: countByRule(remaining),
		diagnostics: remaining.slice(0, limit),
		truncated: remaining.length > limit,
		...(fixedCode !== undefined ? { fixed_code: fixedCode } : {}),
	};
}

const ruffCheckTool = (setup: PluginSetupContext) =>
	createTool<RuffCheckInput, Awaited<ReturnType<typeof ruffCheck>>>({
		name: "ruff_check",
		description:
			"Lint Python code with Ruff (`ruff check`). Reports rule violations (code, message, file, line, column, docs URL, " +
			"whether an auto-fix exists) for files/directories in the project, or for a code snippet. Set fix=true to apply " +
			"Ruff's safe auto-fixes in place (or return the fixed snippet). Respects the project's pyproject.toml / ruff.toml. " +
			"Prefer this over running ruff through the shell.",
		inputSchema: {
			type: "object",
			properties: {
				...commonSchemaProperties,
				fix: {
					type: "boolean",
					description: "Apply auto-fixes. Files are modified in place; for a snippet, the fixed code is returned in fixed_code. Default false.",
				},
				unsafe_fixes: {
					type: "boolean",
					description: "Also consider unsafe fixes (may change behaviour). Only meaningful with fix=true. Default false.",
				},
				select: {
					type: "array",
					items: { type: "string" },
					description: 'Rule codes or prefixes to enable, replacing the configured selection (e.g. ["E", "F", "I", "B"]).',
				},
				extend_select: {
					type: "array",
					items: { type: "string" },
					description: 'Rule codes or prefixes to enable in addition to the configured selection (e.g. ["UP", "SIM"]).',
				},
				ignore: {
					type: "array",
					items: { type: "string" },
					description: 'Rule codes or prefixes to ignore (e.g. ["E501"]).',
				},
				max_diagnostics: {
					type: "integer",
					minimum: 1,
					description: "Maximum number of diagnostics returned in detail (counts are always complete). Default 200.",
				},
			},
			additionalProperties: false,
		},
		execute: (input: RuffCheckInput, ctx: AgentToolContext) => ruffCheck(input, ctx, setup),
	});

// ---------------------------------------------------------------------------
// ruff_format
// ---------------------------------------------------------------------------

interface RuffFormatInput extends CommonInput {
	check?: boolean;
	diff?: boolean;
	line_length?: number;
	preview?: boolean;
}

function formatOptionArgs(input: RuffFormatInput): string[] {
	const args = configArgs(input);
	if (input.line_length !== undefined) args.push("--line-length", String(Math.floor(input.line_length)));
	if (input.preview) args.push("--preview");
	return args;
}

/**
 * Extract the files listed by `ruff format --check`. Handles both the legacy
 * output ("Would reformat: src/a.py") and the diagnostic output of newer Ruff
 * versions ("src/a.py:2:1: unformatted: File would be reformatted").
 */
function parseWouldReformat(output: string): string[] {
	const files = new Set<string>();
	for (const raw of output.split(/\r?\n/)) {
		const line = raw.trim();
		const legacy = /^Would reformat: (.+)$/.exec(line);
		if (legacy) {
			files.add(legacy[1]);
			continue;
		}
		const concise = /^(.+?):\d+:\d+: unformatted\b/.exec(line);
		if (concise) files.add(concise[1]);
	}
	return [...files];
}

async function ruffFormat(input: RuffFormatInput, ctx: AgentToolContext, setup: PluginSetupContext) {
	const cwd = resolveCwd(input, ctx, setup);
	const options = formatOptionArgs(input);

	// --- Snippet mode: format code from stdin and return it. ---------------
	if (usesSnippet(input)) {
		const name = input.filename || "snippet.py";
		const result = await runRuff(["format", ...options, ...stdinArgs(input)], {
			cwd,
			stdin: input.code,
			signal: ctx.signal,
		});
		failIfRuffError(result, "ruff format");
		const changed = result.stdout !== input.code;
		const response: Record<string, unknown> = {
			summary: changed ? `${name} was reformatted.` : `${name} is already formatted.`,
			cwd,
			target: name,
			changed,
			formatted_code: result.stdout,
		};
		if (input.diff && changed) {
			const diffResult = await runRuff(["format", "--diff", ...options, ...stdinArgs(input)], {
				cwd,
				stdin: input.code,
				signal: ctx.signal,
			});
			failIfRuffError(diffResult, "ruff format --diff");
			response.diff = diffResult.stdout;
		}
		return response;
	}

	// --- File mode. ---------------------------------------------------------
	const targets = ["--", ...targetPaths(input)];

	if (input.check || input.diff) {
		// Dry run: never writes. Exit code 1 means "some files would change".
		const checkResult = await runRuff(["format", "--check", ...options, ...targets], { cwd, signal: ctx.signal });
		failIfRuffError(checkResult, "ruff format --check");
		const wouldReformat = parseWouldReformat(`${checkResult.stdout}\n${checkResult.stderr}`);
		const response: Record<string, unknown> = {
			summary:
				checkResult.exitCode === 0
					? "All files are already formatted."
					: `${wouldReformat.length || "Some"} file(s) would be reformatted. Run ruff_format without check/diff to apply.`,
			cwd,
			target: targetPaths(input),
			would_reformat: wouldReformat,
			written: false,
		};
		if (input.diff && checkResult.exitCode !== 0) {
			const diffResult = await runRuff(["format", "--diff", ...options, ...targets], { cwd, signal: ctx.signal });
			failIfRuffError(diffResult, "ruff format --diff");
			response.diff = diffResult.stdout;
		}
		return response;
	}

	// Apply formatting. Find out which files change first, so we can report them.
	const preview = await runRuff(["format", "--check", ...options, ...targets], { cwd, signal: ctx.signal });
	failIfRuffError(preview, "ruff format --check");
	const reformatted = parseWouldReformat(`${preview.stdout}\n${preview.stderr}`);

	const result = await runRuff(["format", ...options, ...targets], { cwd, signal: ctx.signal });
	failIfRuffError(result, "ruff format");
	const output = `${result.stdout}\n${result.stderr}`.trim();

	return {
		summary: output || (reformatted.length > 0 ? `${reformatted.length} file(s) reformatted.` : "Nothing to format."),
		cwd,
		target: targetPaths(input),
		reformatted,
		written: true,
	};
}

const ruffFormatTool = (setup: PluginSetupContext) =>
	createTool<RuffFormatInput, Record<string, unknown>>({
		name: "ruff_format",
		description:
			"Format Python code with Ruff (`ruff format`, a Black-compatible formatter). By default formats the given " +
			"files/directories in place and reports which files changed. Use check=true to only list files that would be " +
			"reformatted, diff=true to get a unified diff without writing, or pass a code snippet to get the formatted code " +
			"back. Respects the project's pyproject.toml / ruff.toml. Prefer this over running ruff through the shell.",
		inputSchema: {
			type: "object",
			properties: {
				...commonSchemaProperties,
				check: {
					type: "boolean",
					description: "Dry run: only report which files would be reformatted, without writing. Default false.",
				},
				diff: {
					type: "boolean",
					description: "Dry run: return a unified diff of the changes, without writing. Default false.",
				},
				line_length: {
					type: "integer",
					minimum: 1,
					maximum: 320,
					description: "Override the configured line length.",
				},
				preview: {
					type: "boolean",
					description: "Enable Ruff's preview formatting style. Default false.",
				},
			},
			additionalProperties: false,
		},
		execute: (input: RuffFormatInput, ctx: AgentToolContext) => ruffFormat(input, ctx, setup),
	});

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin: AgentPlugin = {
	name: "ruff",
	manifest: {
		capabilities: ["tools"],
	},
	setup(api: PluginSetupApi, ctx: PluginSetupContext) {
		api.registerTool(ruffCheckTool(ctx ?? {}));
		api.registerTool(ruffFormatTool(ctx ?? {}));
	},
};

export { plugin };
export default plugin;
