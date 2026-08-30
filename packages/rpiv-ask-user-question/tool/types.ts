import { type Static, Type } from "typebox";
import { LABELS_BY_KIND, ROW_INTENT_META } from "../state/row-intent.js";

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
/**
 * Display width of the header chip. A longer header is truncated at render
 * (`TabBar`, and the single-question inline badge) rather than rejected, so a
 * caller conditioned on another harness's questionnaire tool never loses a turn
 * to a validation error over a cosmetic field.
 */
export const MAX_HEADER_LENGTH = 16;

/**
 * User-facing labels for the three runtime sentinel rows, keyed by their
 * `WrappingSelectItem.kind` discriminator. Sourced from
 * `ROW_INTENT_META` via `LABELS_BY_KIND` (`row-intent.ts`) — single source of
 * truth. Adding a new sentinel requires extending the `WrappingSelectItem`
 * union AND adding an entry to `ROW_INTENT_META`; this map then auto-extends.
 */
export const SENTINEL_LABELS = LABELS_BY_KIND;

export type SentinelKind = keyof typeof SENTINEL_LABELS;
export type SentinelLabel = (typeof SENTINEL_LABELS)[SentinelKind];

/**
 * Labels the runtime owns. Retained as the descriptive set for the sentinel
 * rows; it is no longer a rejection list, and normalization does NOT drop every
 * member.
 *
 * Order is pinned by `types.test.ts` — keep the explicit
 * `["Other", other, next]` literal so consumers using
 * `RESERVED_LABELS[i]` indexing or `Set` membership see no behavior change.
 */
export const RESERVED_LABELS = ["Other", ROW_INTENT_META.other.label, ROW_INTENT_META.next.label] as const;
export type ReservedLabel = (typeof RESERVED_LABELS)[number];

/**
 * The only label normalization removes. `"Other"` is the alias callers reach for
 * out of habit when conditioned on a questionnaire tool whose custom row carries
 * that name; this dialog appends its own custom row instead, so an authored
 * "Other" is a duplicate affordance and dropping it costs the user no choice.
 *
 * Deliberately NOT the whole of `RESERVED_LABELS`. `"Type something."` and
 * `"Next"` are this dialog's sentinel labels but are ordinary option labels
 * elsewhere, so dropping them would delete a real choice the caller meant to
 * offer. They are accepted as normal options; rows are keyed by `kind`, not by
 * label, so an authored row sharing a sentinel's text stays distinct from it.
 */
export const DROPPED_ALIAS_LABELS = ["Other"] as const;

export const OptionSchema = Type.Object({
	label: Type.String({
		description:
			"The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice. Long labels are wrapped or clipped to the column at render, never rejected.",
	}),
	description: Type.String({
		description:
			"Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.",
	}),
	preview: Type.Optional(
		Type.String({
			description:
				"Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.",
		}),
	),
});

export const QuestionSchema = Type.Object({
	question: Type.String({
		description:
			'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
	}),
	header: Type.String({
		description: `Very short chip/tag shown next to the question, about ${MAX_HEADER_LENGTH} characters. Longer text is truncated in the chip rather than rejected. Examples: "Auth method", "Library", "Approach".`,
	}),
	options: Type.Array(OptionSchema, {
		minItems: MIN_OPTIONS,
		maxItems: MAX_OPTIONS,
		description:
			"The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
	}),
	multiSelect: Type.Optional(
		Type.Boolean({
			default: false,
			description:
				"Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.",
		}),
	),
});

export const QuestionsSchema = Type.Array(QuestionSchema, {
	minItems: 1,
	maxItems: MAX_QUESTIONS,
	description: "Questions to ask the user (1-4 questions)",
});

export const QuestionParamsSchema = Type.Object({
	questions: QuestionsSchema,
});

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;

/**
 * Answer-intent discriminated union. `kind` is the single discriminator —
 * pre-1.0.3 boolean flags have been removed (see `banned-flags.test.ts`).
 * Mirrors the row-side `WrappingSelectItem.kind` vocabulary where possible;
 * `multi` is the multi-select variant (no row-side analog).
 *
 * Variant semantics:
 * - `option`: user picked one of the author-defined options. `answer` is the option's label.
 * - `custom`: user typed free-text on a single-select question. `answer` is the typed text or null.
 * - `multi`: user committed a multi-select question. `selected` carries chosen labels and `answer`
 *   carries optional custom text.
 */
export interface QuestionAnswer {
	questionIndex: number;
	question: string;
	kind: "option" | "custom" | "multi";
	answer: string | null;
	selected?: string[];
	notes?: string;
	/**
	 * Markdown text from the matched option's `preview` field, populated only
	 * when the user lands on a single-select option carrying a `preview`.
	 * Used by `buildQuestionnaireResponse` to echo `selected preview: <preview>`
	 * into the LLM-facing envelope. Undefined for multi-select and custom-text
	 * (`kind: "custom"`) answers.
	 */
	preview?: string;
}

export type QuestionnaireError =
	| "no_ui"
	| "no_custom_ui"
	| "no_questions"
	| "empty_options"
	| "too_many_questions"
	| "duplicate_question"
	| "duplicate_option_label"
	| "session_load_failed"
	| "stale_module_cache";

export interface QuestionnaireResult {
	answers: QuestionAnswer[];
	cancelled: boolean;
	/**
	 * Global note authored on the Submit tab: `n` opens the shared notes editor there,
	 * and the committed text lives at the `notesByTab[questions.length]` pseudo-index
	 * (a slot no question tab can occupy) until `doneFor` lifts it onto the result —
	 * attached on both submit and cancel, like per-question `answers[].notes`.
	 * Conditional-spread contract, mirroring `QuestionAnswer.notes`: the key appears
	 * only via conditional spread of a non-empty string — never assigned `undefined`,
	 * never kept for an empty/whitespace-only draft — so note-free results stay
	 * byte-identical (`!("globalNote" in result)` holds).
	 */
	globalNote?: string;
	error?: QuestionnaireError;
}

export function isQuestionnaireResult(value: unknown): value is QuestionnaireResult {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return Array.isArray(v.answers) && typeof v.cancelled === "boolean";
}
