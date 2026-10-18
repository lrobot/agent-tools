import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import {
	classifyCursorFrame,
	interactionQueryResultCase,
	mapNativeExecToPiTool,
	resolveToolCallCoalesceMs,
	TOOL_CALL_COALESCE_MS,
} from "../cursor/stream-lifecycle.ts";

test("only visible tokens and Pi-bound tools count as stall progress", () => {
	assert.equal(classifyCursorFrame({ messageCase: "interactionUpdate", updateCase: "heartbeat" }).countsAsProgress, false);
	assert.equal(classifyCursorFrame({ messageCase: "interactionUpdate", updateCase: "textDelta" }).countsAsProgress, true);
	assert.equal(classifyCursorFrame({ messageCase: "interactionUpdate", updateCase: "thinkingDelta" }).countsAsProgress, true);
	assert.equal(classifyCursorFrame({ messageCase: "interactionUpdate", updateCase: "tokenDelta" }).countsAsProgress, true);
	assert.equal(classifyCursorFrame({ messageCase: "interactionUpdate", updateCase: "stepStarted" }).countsAsProgress, false);
	assert.equal(classifyCursorFrame({ messageCase: "conversationCheckpointUpdate" }).countsAsProgress, false);
	assert.equal(classifyCursorFrame({ messageCase: "kvServerMessage" }).countsAsProgress, false);
	assert.equal(classifyCursorFrame({ messageCase: "execServerMessage", execCase: "mcpArgs" }).countsAsProgress, true);
	assert.equal(classifyCursorFrame({ messageCase: "execServerMessage", execCase: "shellArgs" }).countsAsProgress, false);
	assert.equal(classifyCursorFrame({ messageCase: "interactionQuery" }).countsAsProgress, false);
	assert.equal(classifyCursorFrame({ messageCase: "execServerControlMessage" }).countsAsProgress, false);
});

test("turnEnded completes the OpenAI turn the way every other provider does", () => {
	const ended = classifyCursorFrame({ messageCase: "interactionUpdate", updateCase: "turnEnded" });
	assert.equal(ended.completesTurn, true);
	assert.equal(ended.countsAsProgress, false);
	assert.equal(classifyCursorFrame({ messageCase: "interactionUpdate", updateCase: "textDelta" }).completesTurn, false);
	assert.equal(classifyCursorFrame({ messageCase: "conversationCheckpointUpdate" }).completesTurn, false);
});

test("native Cursor tools map onto Pi MCP tools instead of spinning on rejection", () => {
	const tools = new Set(["read", "write", "bash", "grep"]);
	assert.deepEqual(mapNativeExecToPiTool("readArgs", { path: "/tmp/a.ts", toolCallId: "1" }, tools), {
		toolName: "read",
		args: { path: "/tmp/a.ts" },
		resultCase: "readResult",
	});
	assert.equal(mapNativeExecToPiTool("writeArgs", { path: "/tmp/a.ts", fileText: "x" }, tools)?.toolName, "write");
	assert.equal(mapNativeExecToPiTool("shellArgs", { command: "echo hi", workingDirectory: "/tmp" }, tools)?.toolName, "bash");
	assert.equal(mapNativeExecToPiTool("shellStreamArgs", { command: "pwd" }, tools)?.resultCase, "shellStream");
	assert.equal(mapNativeExecToPiTool("grepArgs", { pattern: "foo", path: "src" }, tools)?.toolName, "grep");
	assert.equal(mapNativeExecToPiTool("lsArgs", { path: "." }, tools)?.toolName, "bash");
	assert.equal(mapNativeExecToPiTool("deleteArgs", { path: "/tmp/a.ts" }, tools)?.resultCase, "deleteResult");
	assert.equal(mapNativeExecToPiTool("computerUseArgs", {}, tools), undefined);
	assert.equal(mapNativeExecToPiTool("readArgs", { path: "a.ts" }, new Set()), undefined);
});

test("sibling Cursor tools share one coalesce window so a burst cannot close the turn early", () => {
	assert.equal(TOOL_CALL_COALESCE_MS, 75);
	assert.equal(resolveToolCallCoalesceMs({}), TOOL_CALL_COALESCE_MS);
	assert.equal(resolveToolCallCoalesceMs({ PI_CURSOR_TOOL_COALESCE_MS: "20" }), 20);
	assert.equal(resolveToolCallCoalesceMs({ PI_CURSOR_TOOL_COALESCE_MS: "0" }), TOOL_CALL_COALESCE_MS, "0 would flush each exec alone and reintroduce the hang");
	assert.equal(resolveToolCallCoalesceMs({ PI_CURSOR_TOOL_COALESCE_MS: "soon" }), TOOL_CALL_COALESCE_MS);
});

test("every Cursor mid-turn question has a named reply so the bridge cannot wait forever", () => {
	assert.equal(interactionQueryResultCase("webSearchRequestQuery"), "webSearchRequestResponse");
	assert.equal(interactionQueryResultCase("askQuestionInteractionQuery"), "askQuestionInteractionResponse");
	assert.equal(interactionQueryResultCase("switchModeRequestQuery"), "switchModeRequestResponse");
	assert.equal(interactionQueryResultCase("exaSearchRequestQuery"), "exaSearchRequestResponse");
	assert.equal(interactionQueryResultCase("exaFetchRequestQuery"), "exaFetchRequestResponse");
	assert.equal(interactionQueryResultCase("createPlanRequestQuery"), "createPlanRequestResponse");
	assert.equal(interactionQueryResultCase("setupVmEnvironmentArgs"), "setupVmEnvironmentResult");
	assert.equal(interactionQueryResultCase("inventedQuery"), undefined);
});

test("a live Cursor SSE stream ends on turnEnded and does not treat checkpoints as progress", () => {
	execFileSync(process.execPath, ["--import", new URL("./fixtures/typescript-loader.mjs", import.meta.url).href, "--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { EventEmitter } from "node:events";
		import { mock } from "node:test";
		import { create, toBinary } from "@bufbuild/protobuf";
		import { AgentServerMessageSchema } from "./cursor/proto/agent_pb.ts";
		import { writeSSEStreamForTests } from "./cursor/proxy.ts";

		process.env.PI_CURSOR_UPSTREAM_STALL_MS = "200";
		process.env.PI_CURSOR_TOOL_COALESCE_MS = "20";
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		mock.method(performance, "now", () => Date.now());
		function frame(message) {
			const payload = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message }));
			const bytes = Buffer.alloc(5 + payload.length);
			bytes.writeUInt32BE(payload.length, 1);
			bytes.set(payload, 5);
			return bytes;
		}
		function stream(tools = []) {
			let receive;
			let output = "";
			const writes = [];
			const req = new EventEmitter();
			const res = Object.assign(new EventEmitter(), {
				writableEnded: false, destroyed: false,
				writeHead() {}, flushHeaders() {},
				write(data) { output += data; },
				end() { this.writableEnded = true; },
			});
			const bridge = {
				alive: true, proc: { kill() {} },
				write(data) { writes.push(data); },
				end() {}, destroy() {},
				onData(callback) { receive = callback; }, onClose() {},
			};
			writeSSEStreamForTests({
				bridge, heartbeatTimer: setInterval(() => {}, 5000),
				mcpTools: tools,
				modelId: "fixture", bridgeKey: "fixture", convKey: "fixture",
				completedTurns: [], currentTurn: { user: [], steps: [] }, req, res,
			});
			return { res, receive: (bytes) => receive(bytes), output: () => output, writes };
		}
		try {
			const ended = stream();
			ended.receive(frame({ case: "interactionUpdate", value: { message: { case: "textDelta", value: { text: "done" } } } }));
			ended.receive(frame({ case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } }));
			assert.equal(ended.res.writableEnded, true, "turnEnded must close the OpenAI stream");
			assert.match(ended.output(), /"finish_reason":"stop"/);

			const housekeeping = stream();
			for (let i = 0; i < 10; i++) {
				housekeeping.receive(frame({ case: "conversationCheckpointUpdate", value: {} }));
				housekeeping.receive(frame({ case: "kvServerMessage", value: { message: { case: "getBlobArgs", value: { blobId: new Uint8Array() } } } }));
				mock.timers.tick(50);
			}
			assert.equal(housekeeping.res.writableEnded, true, "checkpoints and blob fetches must not postpone a stall");
			assert.match(housekeeping.output(), /stream timed out/);

			const query = stream();
			query.receive(frame({
				case: "interactionQuery",
				value: { id: 7, query: { case: "webSearchRequestQuery", value: {} } },
			}));
			assert.equal(query.res.writableEnded, false, "a rejected question must not end the turn");
			assert.ok(query.writes.length >= 1, "Cursor must receive an interaction response");
			mock.timers.tick(250);
			assert.equal(query.res.writableEnded, true, "an unanswered-looking question still cannot freeze the watchdog");

			const native = stream([{ name: "read", toolName: "read" }]);
			native.receive(frame({
				case: "execServerMessage",
				value: { id: 1, execId: "e1", message: { case: "readArgs", value: { path: "/tmp/a.ts" } } },
			}));
			assert.equal(native.res.writableEnded, false, "the first read must wait for sibling tools in the same burst");
			mock.timers.tick(20);
			assert.equal(native.res.writableEnded, true, "a native read with a Pi read tool must pause like MCP");
			assert.match(native.output(), /"finish_reason":"tool_calls"/);
			assert.match(native.output(), /"name":"read"/);
			assert.equal((native.output().match(/"finish_reason":"tool_calls"/g) ?? []).length, 1);

			const parallel = stream([{ name: "read", toolName: "read" }]);
			parallel.receive(frame({
				case: "execServerMessage",
				value: { id: 1, execId: "e1", message: { case: "readArgs", value: { path: "/tmp/a.ts", toolCallId: "r1" } } },
			}));
			parallel.receive(frame({
				case: "execServerMessage",
				value: { id: 2, execId: "e2", message: { case: "readArgs", value: { path: "/tmp/b.ts", toolCallId: "r2" } } },
			}));
			assert.equal(parallel.res.writableEnded, false, "two reads must not close the OpenAI stream on the first frame");
			mock.timers.tick(20);
			assert.equal(parallel.res.writableEnded, true, "the burst must become one tool_calls pause");
			assert.equal((parallel.output().match(/"finish_reason":"tool_calls"/g) ?? []).length, 1, "one pause, not one per exec");
			assert.match(parallel.output(), /"id":"r1"/);
			assert.match(parallel.output(), /"id":"r2"/);
			assert.equal((parallel.output().match(/"name":"read"/g) ?? []).length, 2);

			const lateWrites = parallel.writes.length;
			const lateOutput = parallel.output();
			parallel.receive(frame({
				case: "execServerMessage",
				value: { id: 3, execId: "e3", message: { case: "readArgs", value: { path: "/tmp/c.ts", toolCallId: "r3" } } },
			}));
			assert.ok(parallel.writes.length > lateWrites, "a late extra exec must be answered on the Cursor bridge");
			assert.equal(parallel.output(), lateOutput, "a late extra exec must not reopen the OpenAI stream");

			const rejected = stream();
			rejected.receive(frame({
				case: "execServerMessage",
				value: { id: 2, execId: "e2", message: { case: "readArgs", value: { path: "/tmp/a.ts" } } },
			}));
			assert.equal(rejected.res.writableEnded, false, "a rejected native tool must not end the turn");
			assert.ok(rejected.writes.length >= 1, "Cursor must receive a native reject so the Run cannot wait forever");
			mock.timers.tick(250);
			assert.equal(rejected.res.writableEnded, true, "a native reject loop still cannot freeze the watchdog");
		} finally {
			mock.timers.reset();
		}
	`], { cwd: new URL("../", import.meta.url), stdio: "pipe" });
});

test("Cursor tokens after tool results reach Pi instead of vanishing on the paused stream", () => {
	execFileSync(process.execPath, ["--import", new URL("./fixtures/typescript-loader.mjs", import.meta.url).href, "--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { EventEmitter } from "node:events";
		import { mock } from "node:test";
		import { create, toBinary } from "@bufbuild/protobuf";
		import { AgentServerMessageSchema } from "./cursor/proto/agent_pb.ts";
		import {
			resumeCursorToolResultsForTests,
			writeSSEStreamForTests,
			__testInternals,
		} from "./cursor/proxy.ts";

		process.env.PI_CURSOR_UPSTREAM_STALL_MS = "200";
		process.env.PI_CURSOR_TOOL_COALESCE_MS = "20";
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		mock.method(performance, "now", () => Date.now());
		function frame(message) {
			const payload = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message }));
			const bytes = Buffer.alloc(5 + payload.length);
			bytes.writeUInt32BE(payload.length, 1);
			bytes.set(payload, 5);
			return bytes;
		}
		function openStream() {
			let receive;
			let output = "";
			const writes = [];
			const req = new EventEmitter();
			const res = Object.assign(new EventEmitter(), {
				writableEnded: false, destroyed: false,
				writeHead() {}, flushHeaders() {},
				write(data) { output += data; },
				end() { this.writableEnded = true; this.emit("close"); },
			});
			const bridge = {
				alive: true, proc: { kill() {} },
				write(data) { writes.push(data); },
				end() {}, destroy() {},
				onData(callback) { receive = callback; }, onClose() {},
			};
			writeSSEStreamForTests({
				bridge, heartbeatTimer: setInterval(() => {}, 5000),
				mcpTools: [{ name: "read", toolName: "read" }],
				modelId: "fixture", bridgeKey: "resume-fixture", convKey: "resume-fixture",
				completedTurns: [], currentTurn: { userText: "go", steps: [] }, req, res,
			});
			return {
				bridge, res, writes,
				receive: (bytes) => receive(bytes),
				output: () => output,
				captureReceive: () => receive,
			};
		}
		try {
			const paused = openStream();
			paused.receive(frame({
				case: "execServerMessage",
				value: { id: 1, execId: "e1", message: { case: "readArgs", value: { path: "/tmp/a.ts", toolCallId: "r1" } } },
			}));
			mock.timers.tick(20);
			assert.equal(paused.res.writableEnded, true, "the OpenAI stream must pause on the native read");

			const active = __testInternals.activeBridges.get("resume-fixture");
			assert.ok(active, "the paused Run must still be on the Cursor bridge");
			__testInternals.activeBridges.delete("resume-fixture");

			// Cursor replies in the same tick it receives the exec result. If we write
			// that result before the new SSE listener is attached, this text is dropped
			// on the paused writer and Pi sits on Working until the stall watchdog.
			paused.bridge.write = (data) => {
				paused.writes.push(data);
				paused.captureReceive()(frame({
					case: "interactionUpdate",
					value: { message: { case: "textDelta", value: { text: "after-tools" } } },
				}));
				paused.captureReceive()(frame({
					case: "interactionUpdate",
					value: { message: { case: "turnEnded", value: {} } },
				}));
			};

			let resumeOutput = "";
			const resumeReq = new EventEmitter();
			const resumeRes = Object.assign(new EventEmitter(), {
				writableEnded: false, destroyed: false,
				writeHead() {}, flushHeaders() {},
				write(data) { resumeOutput += data; },
				end() { this.writableEnded = true; this.emit("close"); },
			});
			resumeCursorToolResultsForTests(
				active,
				[{ toolCallId: "r1", content: "contents of a.ts" }],
				resumeReq,
				resumeRes,
				{ modelId: "fixture", bridgeKey: "resume-fixture", convKey: "resume-fixture" },
			);
			assert.match(resumeOutput, /after-tools/, "the reply after tools must reach the new OpenAI stream");
			assert.match(resumeOutput, /"finish_reason":"stop"/);
			assert.equal(resumeRes.writableEnded, true);
			assert.equal(resumeOutput.includes("stream timed out"), false, "this is a live reply, not a five-minute stall");
		} finally {
			mock.timers.reset();
		}
	`], { cwd: new URL("../", import.meta.url), stdio: "pipe" });
});
