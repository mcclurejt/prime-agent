import { describe, expect, it } from "vitest";
import { rootValidationGuardReason } from "../src/core/root-validation-guard.js";

function reason(code: string, rlmDepth = 0, toolName = "ipython"): string | undefined {
	return rootValidationGuardReason({ rlmDepth, toolName, args: { code } });
}

describe("root validation guard", () => {
	it.each([
		["bash make test", "%%bash\nmake test"],
		["bash make lint", "%%bash\nmake lint"],
		["bash make build", "%%bash\nmake build"],
		["bash npm check", "%%bash\nnpm run check"],
		["bash prefixed npm test", "%%bash\nnpm --prefix frontend test"],
		["bash wrapped make test", "%%bash\ntimeout 30m bash -lc 'make test'"],
		["bash broad go test", "%%bash\ngo test ./..."],
		["bash broad pytest", "%%bash\npytest -q"],
		["python subprocess", "subprocess.run(['make', 'test'], check=True)"],
		["python shell string", "subprocess.run('npm run lint', shell=True, check=True)"],
		["nested Python subprocess", "print(subprocess.run(['npm', 'run', 'check'], check=True))"],
		["bound Python command", "cmd = ['npm', 'run', 'check']\nsubprocess.run(cmd, check=True)"],
		["bound Python tuple", "cmd = ('cargo', 'test', '--workspace')\nsubprocess.run(cmd, check=True)"],
		["bound Python string", "cmd = 'make test'\nos.system(cmd)"],
		["cargo workspace", "%%bash\ncargo test --workspace"],
		["npm config without selector", "%%bash\nnpm test -- --config vitest.config.ts"],
		["pytest ignore without selector", "%%bash\npytest --ignore tests/slow.py"],
		["time wrapper", "%%bash\ntime npm run check"],
		["time valued option wrapper", "%%bash\n/usr/bin/time -o timings.txt npm run check"],
		[
			"python validation helper batch",
			"run_validation('build', ['make', 'build'])\nrun_validation('lint', ['make', 'lint'])\nrun_validation('test', ['make', 'test'])",
		],
	])("blocks %s at root", (_name, code) => {
		expect(reason(code)).toContain("Root broad validation is blocked");
	});

	it.each([
		["targeted go test", "%%bash\ngo test ./sdk/caps -run TestOne"],
		["targeted pytest", "subprocess.run(['pytest', 'tests/test_one.py::test_case', '-q'])"],
		["targeted npm test", "%%bash\nnpm test -- src/one.test.ts"],
		["diff check", "%%bash\ngit diff --check"],
		["source string assignment", 'example = \'subprocess.run(["make", "test"])\''],
		["broad command assigned but not called", "cmd = ['make', 'test']"],
		["printed command", "print('make test')"],
		["shell echo", "%%bash\necho 'make test'"],
		["subprocess echo", "subprocess.run(['echo', 'make test'])"],
		["targeted prefixed npm test", "%%bash\nnpm --prefix frontend test -- src/one.test.ts"],
		["targeted npm test with config", "%%bash\nnpm test -- --config vitest.config.ts src/one.test.ts"],
		["targeted cargo test", "%%bash\ncargo test specific_test --workspace"],
		["quoted here-doc", "%%bash\ncat <<'EOF'\nmake test\nEOF"],
		["comment only", "# subprocess.run(['make', 'test'])\nvalue = 1"],
		["fixture text", 'fixture = """npm run check"""\nassert fixture'],
	])("allows %s at root", (_name, code) => {
		expect(reason(code)).toBeUndefined();
	});

	it("allows the same broad validation in a subagent", () => {
		expect(reason("%%bash\nmake test", 1)).toBeUndefined();
	});

	it("ignores non-IPython tools and malformed arguments", () => {
		expect(reason("make test", 0, "edit")).toBeUndefined();
		expect(rootValidationGuardReason({ rlmDepth: 0, toolName: "ipython", args: {} })).toBeUndefined();
	});
});
