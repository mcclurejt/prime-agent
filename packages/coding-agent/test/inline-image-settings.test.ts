import { existsSync, mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SettingsManager } from "../src/core/settings-manager.js";

describe("inline terminal image settings", () => {
	const testDir = join(process.cwd(), "test-inline-images-tmp");
	const agentDir = join(testDir, "agent");
	const projectDir = join(testDir, "project");

	beforeEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(join(projectDir, ".prime", "agent"), { recursive: true });
	});

	afterEach(() => {
		if (existsSync(testDir)) rmSync(testDir, { recursive: true });
	});

	it("defaults to disabled", () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		expect(manager.getInlineImages()).toBe(false);
	});

	it("persists the opt-in toggle", async () => {
		const manager = SettingsManager.create(projectDir, agentDir);
		manager.setInlineImages(true);
		await manager.flush();

		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf-8"));
		expect(settings.terminal.inlineImages).toBe(true);

		const reloaded = SettingsManager.create(projectDir, agentDir);
		expect(reloaded.getInlineImages()).toBe(true);
	});
});
