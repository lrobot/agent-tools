import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function expandPath(path: string): string {
  if (path.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "/Users/mac";
    return home + path.slice(1);
  }
  return resolve(path);
}

function processIncludes(content: string, baseDir: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  
  for (const line of lines) {
    const trimmed = line.trim();
    // Match @include path or @ path
    const includeMatch = trimmed.match(/^@include\s+(.+)$/) || trimmed.match(/^@\s+(.+)$/);
    if (includeMatch) {
      const includePath = expandPath(includeMatch[1]);
      if (existsSync(includePath)) {
        try {
          const includedContent = readFileSync(includePath, "utf-8");
          result.push(processIncludes(includedContent, resolve(includePath, "..")));
        } catch (e) {
          result.push(line);
        }
      } else {
        result.push(line);
      }
    } else {
      result.push(line);
    }
  }
  
  return result.join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    // Check if system prompt contains @include or @ references
    const prompt = event.systemPrompt;
    if (!prompt.includes("@include") && !prompt.includes("\n@ ")) {
      return undefined;
    }
    
    const processed = processIncludes(prompt, process.cwd());
    if (processed !== prompt) {
      return { systemPrompt: processed };
    }
    
    return undefined;
  });
}
