import { describe, expect, it } from "vitest";
import { normalizeQuestionnaire } from "./normalize-questionnaire.js";
import type { QuestionParams } from "./types.js";

function params(options: Array<{ label: string; description?: string }>, multiSelect = false): QuestionParams {
	return {
		questions: [
			{
				question: "Pick?",
				header: "Pick",
				multiSelect,
				options: options.map((o) => ({ label: o.label, description: o.description ?? "d" })),
			},
		],
	} as QuestionParams;
}

describe("normalizeQuestionnaire", () => {
	it("drops an authored 'Other' option", () => {
		const out = normalizeQuestionnaire(params([{ label: "Other" }, { label: "B" }]));
		expect(out.questions[0]!.options.map((o) => o.label)).toEqual(["B"]);
	});

	it("keeps 'Type something.' and 'Next' as ordinary options", () => {
		const out = normalizeQuestionnaire(params([{ label: "Type something." }, { label: "Next" }]));
		expect(out.questions[0]!.options.map((o) => o.label)).toEqual(["Type something.", "Next"]);
	});

	// The label is the answer identity, echoed back verbatim, so normalization must
	// never rewrite one. Two labels differing only past a cut would otherwise
	// collapse into one ambiguous row.
	it("never truncates a long label or header", () => {
		const long = "x".repeat(200);
		const input = params([{ label: long }, { label: `${long}-different` }]);
		input.questions[0]!.header = "y".repeat(80);
		const out = normalizeQuestionnaire(input);
		expect(out.questions[0]!.options[0]!.label).toBe(long);
		expect(out.questions[0]!.options[1]!.label).toBe(`${long}-different`);
		expect(out.questions[0]!.header).toBe("y".repeat(80));
	});

	it("returns the same reference when nothing is dropped", () => {
		const input = params([{ label: "A" }, { label: "B" }]);
		expect(normalizeQuestionnaire(input)).toBe(input);
	});

	it("leaves descriptions, preview and multiSelect untouched", () => {
		const input = params([{ label: "Other" }, { label: "B", description: "keep me" }], true);
		input.questions[0]!.options[1]!.preview = "# preview";
		const out = normalizeQuestionnaire(input);
		expect(out.questions[0]!.multiSelect).toBe(true);
		expect(out.questions[0]!.options[0]).toMatchObject({
			label: "B",
			description: "keep me",
			preview: "# preview",
		});
	});

	it("drops the alias in every question, not just the first", () => {
		const input: QuestionParams = {
			questions: [
				params([{ label: "A" }, { label: "Other" }]).questions[0]!,
				params([{ label: "Other" }, { label: "C" }]).questions[0]!,
			],
		} as QuestionParams;
		input.questions[1]!.question = "Second?";
		const out = normalizeQuestionnaire(input);
		expect(out.questions[0]!.options.map((o) => o.label)).toEqual(["A"]);
		expect(out.questions[1]!.options.map((o) => o.label)).toEqual(["C"]);
	});
});
