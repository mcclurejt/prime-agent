export interface RootValidationGuardInput {
	rlmDepth: number;
	toolName: string;
	args: unknown;
}

export const ROOT_VALIDATION_GUARD_REASON =
	"Root broad validation is blocked. Delegate one coherent validation batch to a low-cost subagent, then end the turn. Targeted evidence-known-fast checks may run inline. There is no model-controlled root bypass.";

const EXECUTION_FUNCTION =
	/^(?:run|popen|call|check_call|check_output|system|exec|execute|command|run_validation|run_command|run_cmd)$/i;
const EXECUTION_FUNCTION_SUFFIX = /(?:^|_)(?:run|exec|execute|command|validation|cmd)$/i;

export function rootValidationGuardReason(input: RootValidationGuardInput): string | undefined {
	if (input.rlmDepth !== 0 || input.toolName !== "ipython") return undefined;
	if (!isRecord(input.args) || typeof input.args.code !== "string") return undefined;

	const code = input.args.code;
	const blocked = isBashMagic(code) ? shellRunsBroadValidation(code) : pythonRunsBroadValidation(code);
	return blocked ? ROOT_VALIDATION_GUARD_REASON : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isBashMagic(code: string): boolean {
	return code.trimStart().startsWith("%%bash");
}

function shellRunsBroadValidation(code: string): boolean {
	const body = code.trimStart().replace(/^%%bash[^\n]*(?:\n|$)/, "");
	let hereDocTerminator: string | undefined;
	for (const rawLine of body.split("\n")) {
		if (hereDocTerminator) {
			if (rawLine.trim() === hereDocTerminator) hereDocTerminator = undefined;
			continue;
		}
		const line = stripShellComment(rawLine);
		for (const segment of line.split(/&&|\|\||;/)) {
			if (shellSegmentRunsBroadValidation(segment)) return true;
		}
		const hereDoc = line.match(/<<-?\s*(["']?)([A-Za-z_][A-Za-z0-9_-]*)\1/);
		if (hereDoc?.[2] && !shellHereDocExecutesBody(line)) hereDocTerminator = hereDoc[2];
	}
	return false;
}

function shellHereDocExecutesBody(line: string): boolean {
	const tokens = unwrapCommandWrappers(tokenizeShell(line.trim().replace(/^(?:if|then|do)\s+/, "")));
	return ["bash", "sh", "zsh", "python", "python3"].includes(commandBasename(tokens[0]));
}

function shellSegmentRunsBroadValidation(segment: string): boolean {
	const tokens = unwrapCommandWrappers(tokenizeShell(segment.trim().replace(/^(?:if|then|do)\s+/, "")));
	if (["bash", "sh", "zsh"].includes(commandBasename(tokens[0]))) {
		const commandIndex = tokens.findIndex((token) => token === "-c" || token === "-lc");
		return commandIndex >= 0 && tokens[commandIndex + 1] !== undefined
			? shellRunsBroadValidation(`%%bash\n${tokens[commandIndex + 1]}`)
			: false;
	}
	return containsBroadValidationCommand(tokens.join(" "));
}

function unwrapCommandWrappers(input: string[]): string[] {
	const tokens = [...input];
	while (tokens[0]?.includes("=") && !tokens[0]?.startsWith("-")) tokens.shift();
	while (tokens.length > 0) {
		const command = commandBasename(tokens[0]);
		if (command === "env" || command === "sudo" || command === "command") {
			tokens.shift();
			while (tokens[0]?.startsWith("-")) tokens.shift();
			while (tokens[0]?.includes("=") && !tokens[0]?.startsWith("-")) tokens.shift();
			continue;
		}
		if (command === "time") {
			tokens.shift();
			while (tokens[0]?.startsWith("-")) {
				const option = tokens.shift()!;
				if (!option.includes("=") && TIME_OPTIONS_WITH_VALUE.has(option) && tokens[0]) tokens.shift();
			}
			continue;
		}
		if (command === "timeout") {
			tokens.shift();
			while (tokens[0]?.startsWith("-")) tokens.shift();
			if (tokens[0]) tokens.shift();
			continue;
		}
		break;
	}
	return tokens;
}

const TIME_OPTIONS_WITH_VALUE = new Set(["-o", "--output", "-f", "--format"]);

function commandBasename(command: string | undefined): string {
	return command?.split("/").at(-1)?.toLowerCase() ?? "";
}

function tokenizeShell(command: string): string[] {
	const tokens: string[] = [];
	let token = "";
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const char = command[index]!;
		if (char === "\\" && quote !== "'") {
			if (command[index + 1] !== undefined) token += command[++index];
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			else token += char;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (/\s/.test(char)) {
			if (token) tokens.push(token);
			token = "";
			continue;
		}
		token += char;
	}
	if (token) tokens.push(token);
	return tokens;
}

function stripShellComment(line: string): string {
	let quote: "'" | '"' | undefined;
	for (let index = 0; index < line.length; index += 1) {
		const char = line[index]!;
		if (char === "\\" && quote !== "'") {
			index += 1;
			continue;
		}
		if (quote) {
			if (char === quote) quote = undefined;
			continue;
		}
		if (char === "'" || char === '"') {
			quote = char;
			continue;
		}
		if (char === "#") return line.slice(0, index);
	}
	return line;
}

function pythonRunsBroadValidation(code: string): boolean {
	return findPythonCalls(code).some(({ name, args, start }) => {
		const leaf = name.split(".").at(-1) ?? name;
		if (!EXECUTION_FUNCTION.test(leaf) && !EXECUTION_FUNCTION_SUFFIX.test(leaf)) return false;
		return pythonCallRunsBroadValidation(args, code.slice(0, start));
	});
}

function pythonCallRunsBroadValidation(args: string, codeBeforeCall: string): boolean {
	const candidates = literalCommandCandidates(args);
	const bindingName = args.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1];
	if (bindingName) {
		const binding = resolveLiteralBinding(codeBeforeCall, bindingName);
		if (binding) candidates.push(...literalCommandCandidates(binding));
	}
	return candidates.some(containsBroadValidationCommand);
}

function literalCommandCandidates(value: string): string[] {
	const candidates: string[] = [];
	const directString = value.match(/^\s*(?:[rubf]{0,2})?(["'])([\s\S]*?)\1/i);
	if (directString?.[2]) candidates.push(directString[2]);
	for (const collection of value.matchAll(/(?:\[|\()([\s\S]*?)(?:\]|\))/g)) {
		const values = [...(collection[1] ?? "").matchAll(/(?:[rubf]{0,2})?(["'])([\s\S]*?)\1/gi)].map(
			(match) => match[2] ?? "",
		);
		if (values.length > 0) candidates.push(values.join(" "));
	}
	return candidates;
}

function resolveLiteralBinding(code: string, name: string): string | undefined {
	const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const assignment = new RegExp(
		`(?:^|\\n)\\s*${escapedName}\\s*=\\s*(\\[[^\\]]*\\]|\\([^)]*\\)|(?:[rubf]{0,2})?["'][^"']*["'])`,
		"gi",
	);
	let value: string | undefined;
	for (const match of code.matchAll(assignment)) value = match[1];
	return value;
}

interface PythonCall {
	name: string;
	args: string;
	start: number;
}

function findPythonCalls(code: string): PythonCall[] {
	const calls: PythonCall[] = [];
	let index = 0;
	while (index < code.length) {
		const skipped = skipPythonStringOrComment(code, index);
		if (skipped !== index) {
			index = skipped;
			continue;
		}
		if (!isIdentifierStart(code[index])) {
			index += 1;
			continue;
		}

		const start = index;
		index = consumeIdentifier(code, index);
		while (code[index] === "." && isIdentifierStart(code[index + 1])) {
			index = consumeIdentifier(code, index + 1);
		}
		const name = code.slice(start, index);
		while (/\s/.test(code[index] ?? "")) index += 1;
		if (code[index] !== "(") continue;
		const end = findMatchingParen(code, index);
		if (end === undefined) continue;
		const openIndex = index;
		calls.push({ name, args: code.slice(openIndex + 1, end), start });
		index = openIndex + 1;
	}
	return calls;
}

function findMatchingParen(code: string, openIndex: number): number | undefined {
	let depth = 1;
	let index = openIndex + 1;
	while (index < code.length) {
		const skipped = skipPythonStringOrComment(code, index);
		if (skipped !== index) {
			index = skipped;
			continue;
		}
		if (code[index] === "(") depth += 1;
		if (code[index] === ")") {
			depth -= 1;
			if (depth === 0) return index;
		}
		index += 1;
	}
	return undefined;
}

function skipPythonStringOrComment(code: string, index: number): number {
	if (code[index] === "#") {
		const newline = code.indexOf("\n", index + 1);
		return newline === -1 ? code.length : newline + 1;
	}
	const quote = code[index];
	if (quote !== "'" && quote !== '"') return index;
	const triple = code.slice(index, index + 3) === quote.repeat(3);
	const delimiter = triple ? quote.repeat(3) : quote;
	let cursor = index + delimiter.length;
	while (cursor < code.length) {
		if (code[cursor] === "\\") {
			cursor += 2;
			continue;
		}
		if (code.slice(cursor, cursor + delimiter.length) === delimiter) {
			return cursor + delimiter.length;
		}
		cursor += 1;
	}
	return code.length;
}

function isIdentifierStart(char: string | undefined): boolean {
	return char !== undefined && /[A-Za-z_]/.test(char);
}

function consumeIdentifier(code: string, index: number): number {
	let cursor = index + 1;
	while (/[A-Za-z0-9_]/.test(code[cursor] ?? "")) cursor += 1;
	return cursor;
}

function containsBroadValidationCommand(raw: string): boolean {
	const tokens = unwrapCommandWrappers(tokenizeShell(raw.toLowerCase()));
	const command = commandBasename(tokens[0]);

	if (command === "make") {
		return ["test", "lint", "build", "fmt", "fmtcheck", "check", "helm-test"].includes(tokens[1] ?? "");
	}
	if (command === "go" && tokens[1] === "test") return tokens.slice(2).some((token) => token.endsWith("/..."));

	let pytestIndex = command === "pytest" || command === "py.test" ? 0 : -1;
	if (command === "uv" && tokens[1] === "run" && (tokens[2] === "pytest" || tokens[2] === "py.test")) pytestIndex = 2;
	if (pytestIndex >= 0) {
		const selectors = positionalArguments(tokens.slice(pytestIndex + 1), PYTEST_OPTIONS_WITH_VALUE);
		return !selectors.some((selector) => selector.includes("::") || selector.endsWith(".py"));
	}

	if (command === "cargo" && tokens[1] === "test") {
		return positionalArguments(tokens.slice(2), CARGO_OPTIONS_WITH_VALUE).length === 0;
	}

	if (["npm", "pnpm", "yarn", "bun"].includes(command)) {
		let index = 1;
		if (tokens[index] === "--prefix") index += 2;
		if (tokens[index] === "run") index += 1;
		const script = tokens[index];
		if (!script || !["test", "lint", "build", "check", "typecheck", "fmt", "format"].includes(script)) return false;
		if (script !== "test") return true;
		const testArgs = tokens.slice(index + 1).filter((token, tokenIndex) => !(tokenIndex === 0 && token === "--"));
		const selectors = positionalArguments(testArgs, NPM_TEST_OPTIONS_WITH_VALUE);
		return !selectors.some((selector) => /(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(selector));
	}
	return false;
}

const PYTEST_OPTIONS_WITH_VALUE = new Set([
	"-c",
	"--config-file",
	"--rootdir",
	"--ignore",
	"--ignore-glob",
	"--deselect",
	"-k",
	"-m",
	"--maxfail",
	"--tb",
]);
const CARGO_OPTIONS_WITH_VALUE = new Set([
	"-p",
	"--package",
	"--exclude",
	"--manifest-path",
	"--features",
	"--target",
	"-j",
	"--jobs",
]);
const NPM_TEST_OPTIONS_WITH_VALUE = new Set([
	"-c",
	"--config",
	"--config-file",
	"--project",
	"--root",
	"--testnamepattern",
	"-t",
]);

function positionalArguments(tokens: string[], optionsWithValue: ReadonlySet<string>): string[] {
	const positional: string[] = [];
	for (let index = 0; index < tokens.length; index += 1) {
		const token = tokens[index]!;
		if (token === "--") continue;
		if (token.startsWith("-")) {
			if (!token.includes("=") && optionsWithValue.has(token)) index += 1;
			continue;
		}
		positional.push(token);
	}
	return positional;
}
