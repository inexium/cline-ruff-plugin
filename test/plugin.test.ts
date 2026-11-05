import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import plugin from "../index.ts";

type Tool = {
	name: string;
	inputSchema: Record<string, unknown>;
	execute: (input: unknown, ctx: unknown) => Promise<any>;
};

const UGLY = "import os, sys\nx=1\ndef f( a ):\n  return a==None\n";

let dir: string;
const tools = new Map<string, Tool>();

function toolCtx() {
	return { agentId: "test", iteration: 0, cwd: dir };
}

before(async () => {
	dir = mkdtempSync(join(tmpdir(), "cline-ruff-"));
	writeFileSync(join(dir, "pyproject.toml"), '[tool.ruff.lint]\nselect = ["E", "F", "I"]\n');
	await plugin.setup?.(
		{
			registerTool: (tool: Tool) => tools.set(tool.name, tool),
		} as never,
		{ cwd: dir },
	);
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe("plugin", () => {
	test("registers ruff_check and ruff_format", () => {
		assert.deepEqual([...tools.keys()].sort(), ["ruff_check", "ruff_format"]);
		assert.deepEqual(plugin.manifest.capabilities, ["tools"]);
	});
});

describe("ruff_check", () => {
	test("reports diagnostics for files", async () => {
		writeFileSync(join(dir, "a.py"), UGLY);
		const out = await tools.get("ruff_check")!.execute({ paths: ["a.py"] }, toolCtx());
		const codes = out.diagnostics.map((d: { code: string }) => d.code).sort();
		assert.deepEqual(codes, ["E401", "E711", "F401", "F401", "I001"]);
		assert.equal(out.diagnostics[0].file, "a.py");
		assert.equal(out.total, 5);
		assert.ok(out.fixable.safe > 0);
		assert.equal(readFileSync(join(dir, "a.py"), "utf8"), UGLY, "must not modify without fix");
	});

	test("fix=true fixes files in place", async () => {
		writeFileSync(join(dir, "b.py"), UGLY);
		const out = await tools.get("ruff_check")!.execute({ paths: ["b.py"], fix: true }, toolCtx());
		assert.ok(out.fixed >= 3, `fixed=${out.fixed}`);
		assert.doesNotMatch(readFileSync(join(dir, "b.py"), "utf8"), /import os/);
	});

	test("lints a snippet and returns fixed code", async () => {
		const out = await tools.get("ruff_check")!.execute(
			{ code: "import os\nprint(undefined_name)\n", fix: true },
			toolCtx(),
		);
		assert.equal(out.fixed_code, "print(undefined_name)\n");
		assert.deepEqual(Object.keys(out.by_rule), ["F821"]);
		assert.equal(out.diagnostics[0].file, "snippet.py");
	});

	test("select / ignore are honoured", async () => {
		const out = await tools.get("ruff_check")!.execute({ code: UGLY, select: ["F"], ignore: ["F401"] }, toolCtx());
		assert.equal(out.total, 0);
		assert.equal(out.summary, "No issues found.");
	});

	test("rejects option-looking paths", async () => {
		await assert.rejects(tools.get("ruff_check")!.execute({ paths: ["--fix"] }, toolCtx()), /must not start with "-"/);
	});
});

describe("ruff_format", () => {
	test("check=true lists files without writing", async () => {
		writeFileSync(join(dir, "c.py"), UGLY);
		const out = await tools.get("ruff_format")!.execute({ paths: ["c.py"], check: true }, toolCtx());
		assert.deepEqual(out.would_reformat, ["c.py"]);
		assert.equal(out.written, false);
		assert.equal(readFileSync(join(dir, "c.py"), "utf8"), UGLY);
	});

	test("diff=true returns a diff without writing", async () => {
		const out = await tools.get("ruff_format")!.execute({ paths: ["c.py"], diff: true }, toolCtx());
		assert.match(out.diff, /\+def f\(a\):/);
		assert.equal(readFileSync(join(dir, "c.py"), "utf8"), UGLY);
	});

	test("formats files in place", async () => {
		const out = await tools.get("ruff_format")!.execute({ paths: ["c.py"] }, toolCtx());
		assert.deepEqual(out.reformatted, ["c.py"]);
		assert.match(readFileSync(join(dir, "c.py"), "utf8"), /def f\(a\):\n {4}return a == None/);
	});

	test("formats a snippet", async () => {
		const out = await tools.get("ruff_format")!.execute({ code: "x=1\n", diff: true }, toolCtx());
		assert.equal(out.formatted_code, "x = 1\n");
		assert.equal(out.changed, true);
		assert.match(out.diff, /\+x = 1/);
	});

	test("syntax errors surface as tool errors", async () => {
		await assert.rejects(tools.get("ruff_format")!.execute({ code: "x = (\n" }, toolCtx()), /ruff format failed/);
	});
});
