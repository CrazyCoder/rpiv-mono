import { DROPPED_ALIAS_LABELS, type QuestionParams } from "./types.js";

const DROPPED_ALIAS_SET: ReadonlySet<string> = new Set(DROPPED_ALIAS_LABELS);

/**
 * Reconcile a caller's questionnaire with this dialog's own affordances, so a
 * call shaped for another harness's questionnaire tool runs instead of failing.
 *
 * The single transformation is dropping an option labelled "Other". That label
 * names the custom-answer row in the tool this one stands in for; here the row
 * is appended automatically, so an authored copy is a duplicate affordance
 * rather than a distinct choice, and removing it costs the user nothing.
 *
 * Everything else is passed through byte-identical. In particular:
 *
 * - No label or header is ever truncated. The label IS the answer identity —
 *   `formatAnswerScalar` echoes it back verbatim — so rewriting one would both
 *   report an answer the caller never offered and risk collapsing two labels
 *   that differ only past the cut into one ambiguous row. Over-long text is a
 *   display concern, handled at render by the column clip in `MultiSelectView`,
 *   the wrap in `WrappingSelect`, and the chip truncation in `TabBar`.
 * - `"Type something."` and `"Next"` survive as ordinary options. They are this
 *   dialog's sentinel labels but ordinary ones elsewhere, and rows are keyed by
 *   `kind` rather than by label, so an authored row carrying that text stays
 *   distinct from the sentinel it resembles.
 *
 * Pure. Returns the input unchanged (same reference) when nothing is dropped,
 * so the common path allocates nothing.
 */
export function normalizeQuestionnaire(typed: QuestionParams): QuestionParams {
	let changed = false;
	const questions = typed.questions.map((q) => {
		const kept = q.options.filter((o) => !DROPPED_ALIAS_SET.has(o.label));
		if (kept.length === q.options.length) return q;
		changed = true;
		return { ...q, options: kept };
	});
	return changed ? { ...typed, questions } : typed;
}
