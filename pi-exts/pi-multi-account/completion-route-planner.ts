import { comparePriority } from "./provider-priority.ts";

export interface RouteModelRef {
	provider: string;
	id: string;
}

export interface RouteAttemptFact {
	operationId: string;
	purpose: string;
	attempt: number;
	model: RouteModelRef;
	dispatched: boolean;
	stopReason: string;
	errorMessage?: string;
	response?: {
		status: number;
		retryAfterMs?: number;
	};
}

export interface RouteRequestFact {
	operationId: string;
	purpose: string;
	attempt: number;
	maxAttempts: number;
	deadlineAt: number;
	sessionModel?: RouteModelRef;
	preferredModels: readonly RouteModelRef[];
	attempts: readonly RouteAttemptFact[];
	previous?: RouteAttemptFact;
}

export type RouteDecision =
	| { action: "route"; model: RouteModelRef; delayMs?: number }
	| { action: "stop"; reason?: string };

export interface RouteFailurePatterns {
	ignore: readonly string[];
	auth: readonly string[];
	limit: readonly string[];
	transient: readonly string[];
	model: readonly string[];
	contextOverflow: readonly string[];
}

export type RouteFailureKind =
	| "success"
	| "aborted"
	| "route_unavailable"
	| "context_overflow"
	| "auth"
	| "limit"
	| "model"
	| "cursor_stall"
	| "transient"
	| "unhandled";

export interface ScoredRouteCandidate<T> {
	model: T;
	remaining: number;
	rotIndex: number;
	rank: number;
	lastRefusalAt: number;
	predictedBusy: boolean;
	confirmed: boolean;
	group: string;
	sameFamily: boolean;
	sameModel: boolean;
	provider: string;
}

export interface RankAutomaticRouteOptions {
	preferLatestModel: boolean;
	preferSameIdentity: boolean;
	providerPriority: readonly string[];
	availableNowOnly: boolean;
	lastLeftProvider?: string;
	lastLeftAt?: number;
	antiPingPongMs: number;
	now: number;
}

function matches(text: string, patterns: readonly string[]): boolean {
	const lower = text.toLowerCase();
	return patterns.some((pattern) => pattern.length > 0 && lower.includes(pattern.toLowerCase()));
}

function sameRoute(left: RouteModelRef, right: RouteModelRef): boolean {
	return left.provider === right.provider && left.id === right.id;
}

function routeKey(route: RouteModelRef): string {
	return `${route.provider}/${route.id}`;
}

function isCursorStall(provider: string, text: string): boolean {
	if (!provider.startsWith("cursor")) return false;
	const lower = text.toLowerCase();
	return (
		(lower.includes("cursor run stalled") && lower.includes("timed out")) ||
		(lower.includes("produced no output") && lower.includes("timed out"))
	);
}

export function classifyRouteAttempt(
	attempt: RouteAttemptFact,
	patterns: RouteFailurePatterns,
): RouteFailureKind {
	if (attempt.stopReason === "route_unavailable") return "route_unavailable";
	if (attempt.stopReason === "aborted") return "aborted";
	if (attempt.stopReason !== "error") return "success";
	const text = attempt.errorMessage?.trim() ?? "";
	if (matches(text, patterns.contextOverflow)) return "context_overflow";
	if (text && matches(text, patterns.ignore)) return "unhandled";
	if (attempt.response?.status === 401 || matches(text, patterns.auth)) return "auth";
	if (
		attempt.response?.status === 402 ||
		attempt.response?.status === 403 ||
		attempt.response?.status === 429 ||
		matches(text, patterns.limit)
	) {
		return "limit";
	}
	if (matches(text, patterns.model)) return "model";
	if (isCursorStall(attempt.model.provider, text)) return "cursor_stall";
	if (attempt.response && attempt.response.status >= 500) return "transient";
	if (matches(text, patterns.transient)) return "transient";
	return "unhandled";
}

export function selectOperationRoute(options: {
	request: RouteRequestFact;
	orderedCandidates: readonly RouteModelRef[];
	patterns: RouteFailurePatterns;
	maxSameRouteTransientRetries: number;
	transientRetryDelayMs: number;
}): RouteDecision {
	const { request } = options;
	const ordered = [...request.preferredModels, ...(request.sessionModel ? [request.sessionModel] : []), ...options.orderedCandidates];
	const candidates = ordered.filter(
		(candidate, index) => ordered.findIndex((other) => sameRoute(candidate, other)) === index,
	);
	const unavailable = new Set(
		request.attempts
			.filter((attempt) => attempt.stopReason === "route_unavailable")
			.map((attempt) => routeKey(attempt.model)),
	);

	if (!request.previous) {
		const initial = candidates.find((candidate) => !unavailable.has(routeKey(candidate)));
		return initial
			? { action: "route", model: initial }
			: { action: "stop", reason: "No completion route is available" };
	}

	const failureKind = classifyRouteAttempt(request.previous, options.patterns);
	if (failureKind === "success") {
		return { action: "stop", reason: "Completion already succeeded" };
	}
	if (failureKind === "aborted") {
		return { action: "stop", reason: "Completion was cancelled" };
	}
	if (failureKind === "context_overflow" || failureKind === "unhandled") {
		return {
			action: "stop",
			reason: `Completion failure is not provider-route evidence (${failureKind})`,
		};
	}

	if (failureKind === "transient" || failureKind === "cursor_stall") {
		const sameRouteTransientFailures = request.attempts.filter(
			(attempt) =>
				sameRoute(attempt.model, request.previous!.model) &&
				["transient", "cursor_stall"].includes(classifyRouteAttempt(attempt, options.patterns)),
		).length;
		if (sameRouteTransientFailures <= options.maxSameRouteTransientRetries) {
			return {
				action: "route",
				model: request.previous.model,
				delayMs: request.previous.response?.retryAfterMs ?? options.transientRetryDelayMs,
			};
		}
	}

	const attempted = new Set(request.attempts.map((attempt) => routeKey(attempt.model)));
	const fallback = candidates.find((candidate) => !attempted.has(routeKey(candidate)));
	return fallback
		? { action: "route", model: fallback }
		: { action: "stop", reason: `No healthy fallback after ${failureKind}` };
}

export function rankAutomaticRouteCandidates<T>(
	scored: readonly ScoredRouteCandidate<T>[],
	options: RankAutomaticRouteOptions,
): T[] {
	const byRankThenRotation = (left: ScoredRouteCandidate<T>, right: ScoredRouteCandidate<T>) =>
		(options.preferLatestModel ? left.rank - right.rank : 0) || left.rotIndex - right.rotIndex;
	const byPolicy = (left: ScoredRouteCandidate<T>, right: ScoredRouteCandidate<T>) =>
		(options.preferSameIdentity
			? Number(right.sameModel) - Number(left.sameModel) || Number(right.sameFamily) - Number(left.sameFamily)
			: 0) ||
		Number(right.confirmed) - Number(left.confirmed) ||
		Number(left.predictedBusy) - Number(right.predictedBusy) ||
		comparePriority(left.group, right.group, options.providerPriority) ||
		left.lastRefusalAt - right.lastRefusalAt ||
		byRankThenRotation(left, right);

	let available = scored.filter((candidate) => candidate.remaining === 0).sort(byPolicy);
	if (
		options.lastLeftProvider &&
		options.lastLeftAt !== undefined &&
		options.now - options.lastLeftAt < options.antiPingPongMs &&
		available.length > 1
	) {
		const alternatives = available.filter((candidate) => candidate.provider !== options.lastLeftProvider);
		if (alternatives.length > 0) available = alternatives;
	}
	if (available.length > 0) return available.map((candidate) => candidate.model);
	if (options.availableNowOnly) return [];
	return [...scored]
		.sort((left, right) => left.remaining - right.remaining || byPolicy(left, right))
		.map((candidate) => candidate.model);
}
