import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

// A shell's exit EVENT is not the end of its exec RPC response stream. Cursor
// drains that stream until ExecClientStreamClose, even while Run heartbeats flow.
// The 2026-09-16 field incident paused forever after a successful native shell.
test("native shell success, failure and rejection close the exec stream so Cursor can continue", () => {
	const output = execFileSync(process.execPath, ["--import", new URL("./fixtures/typescript-loader.mjs", import.meta.url).href, "--input-type=module", "-e", `
		import assert from "node:assert/strict";
		import { EventEmitter } from "node:events";
		import { mock } from "node:test";
		import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
		import { AgentClientMessageSchema, AgentServerMessageSchema } from "./cursor/proto/agent_pb.ts";
		import { writeSSEStreamForTests, resumeCursorToolResultsForTests, __testInternals } from "./cursor/proxy.ts";
		mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"] });
		mock.method(performance, "now", () => Date.now());
		process.env.PI_CURSOR_TOOL_COALESCE_MS = "20";
		process.env.PI_CURSOR_UPSTREAM_STALL_MS = "200";

		function frame(message) {
			const body = toBinary(AgentServerMessageSchema, create(AgentServerMessageSchema, { message }));
			const bytes = Buffer.alloc(5 + body.length); bytes.writeUInt32BE(body.length, 1); bytes.set(body, 5); return bytes;
		}
		function response() {
			let output = "";
			const res = Object.assign(new EventEmitter(), {
				writableEnded: false, destroyed: false,
				writeHead() {}, flushHeaders() {}, write(data) { output += data; },
				end() { this.writableEnded = true; this.emit("close"); },
			});
			return { req: new EventEmitter(), res, output: () => output };
		}
		try {
			for (const scenario of ["success", "failure", "rejected"]) {
				let receive;
				const sent = [];
				const id = scenario === "success" ? 17 : scenario === "failure" ? 18 : 19;
				const key = "native-shell-" + scenario;
				const bridge = {
					alive: true, proc: { kill() {} },
					write(data) {
						const message = fromBinary(AgentClientMessageSchema, data.subarray(5)).message;
						sent.push(message);
						if (message.case === "execClientControlMessage" && message.value.message.case === "streamClose") {
							assert.equal(message.value.message.value.id, id, "close the original exec RPC, not a tool id");
						}
					},
					end() { this.alive = false; }, destroy() { this.alive = false; },
					onData(cb) { receive = cb; }, onClose() {},
				};
				const first = response();
				writeSSEStreamForTests({
					bridge, heartbeatTimer: setInterval(() => {}, 5000),
					mcpTools: scenario === "rejected" ? [] : [{ name: "bash", toolName: "bash" }],
					modelId: "fixture", bridgeKey: key, convKey: key, completedTurns: [],
					currentTurn: { userText: "run shell", steps: [] }, req: first.req, res: first.res,
				});
				receive(frame({ case: "execServerMessage", value: {
					id, execId: "exec-" + id, message: { case: "shellStreamArgs", value: {
						command: "printf shell", workingDirectory: "/tmp", toolCallId: "shell-" + id,
					} },
				} }));
				let final = first;
				if (scenario !== "rejected") {
					mock.timers.tick(20);
					assert.match(first.output(), /"finish_reason":"tool_calls"/);
					const active = __testInternals.activeBridges.get(key);
					assert.ok(active);
					__testInternals.activeBridges.delete(key);
					final = response();
					// Exercise both success and error encoders via the cached turn result.
					active.currentTurn.steps[0].result = { content: "shell output", isError: scenario === "failure" };
					resumeCursorToolResultsForTests(active, [], final.req, final.res, {
						modelId: "fixture", bridgeKey: key, convKey: key,
					});
				}
				const execs = sent.filter(m => m.case === "execClientMessage");
				const closes = sent.filter(m => m.case === "execClientControlMessage" && m.value.message.case === "streamClose");
				assert.equal(closes.length, 1, scenario + ": a terminal shell event needs exactly one exec streamClose");
				assert.equal(sent.at(-1), closes[0], "streamClose must follow stdout/exit or rejection");
				if (scenario !== "rejected") {
					assert.deepEqual(execs.map(m => m.value.message.value.event.case), ["stdout", "exit"]);
					assert.equal(execs[1].value.message.value.event.value.code, scenario === "failure" ? 1 : 0);
				} else assert.equal(execs[0].value.message.value.event.case, "rejected");

				// Cursor can finish only after its streaming RPC consumer sees close.
				receive(frame({ case: "interactionUpdate", value: { message: { case: "textDelta", value: { text: "after-shell" } } } }));
				receive(frame({ case: "interactionUpdate", value: { message: { case: "turnEnded", value: {} } } }));
				assert.equal(final.res.writableEnded, true);
				assert.match(final.output(), /after-shell/);
				assert.match(final.output(), /"finish_reason":"stop"/);
				mock.timers.tick(250);
				assert.doesNotMatch(final.output(), /stream timed out/);
			}
			console.log("SHELL_STREAM_CLOSED");
		} finally { mock.timers.reset(); }
	`], { cwd: new URL("../", import.meta.url), encoding: "utf8", stdio: "pipe" });
	assert.match(output, /SHELL_STREAM_CLOSED/);
});
