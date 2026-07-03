// Copyright (c) Microsoft Corporation.
// Licensed under the MIT license.

/**
 * A tiny, side-effect-free arithmetic expression evaluator used for
 * `transform`, `payload.length` and container expressions in NVM profiles.
 *
 * It deliberately does NOT use `eval`/`Function`. Only a whitelist of
 * operators, numeric literals, identifiers (resolved from a caller-provided
 * scope) and the `min`/`max` functions are supported. See docs/design.md §6.3.
 */

export type Scope = Record<string, number>;

type Token =
	| { kind: "num"; value: number }
	| { kind: "ident"; value: string }
	| { kind: "op"; value: string };

const OPERATORS = new Set(["+", "-", "*", "/", "%", "<<", ">>", "&", "|", "^", "~", "(", ")", ","]);

function tokenize(input: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < input.length) {
		const ch = input[i];
		if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
			i++;
			continue;
		}
		// Hex or decimal number.
		if (ch >= "0" && ch <= "9") {
			let j = i + 1;
			if (ch === "0" && (input[j] === "x" || input[j] === "X")) {
				j++;
				while (j < input.length && /[0-9a-fA-F]/.test(input[j])) j++;
				tokens.push({ kind: "num", value: parseInt(input.slice(i, j), 16) });
			} else {
				while (j < input.length && /[0-9.]/.test(input[j])) j++;
				tokens.push({ kind: "num", value: Number(input.slice(i, j)) });
			}
			i = j;
			continue;
		}
		// Identifier ($field, alphanumeric, underscore).
		if (ch === "$" || ch === "_" || /[a-zA-Z]/.test(ch)) {
			let j = i + 1;
			while (j < input.length && /[a-zA-Z0-9_$]/.test(input[j])) j++;
			tokens.push({ kind: "ident", value: input.slice(i, j) });
			i = j;
			continue;
		}
		// Two-character operators.
		const two = input.slice(i, i + 2);
		if (two === "<<" || two === ">>") {
			tokens.push({ kind: "op", value: two });
			i += 2;
			continue;
		}
		if (OPERATORS.has(ch)) {
			tokens.push({ kind: "op", value: ch });
			i++;
			continue;
		}
		throw new Error(`Unexpected character "${ch}" in expression: ${input}`);
	}
	return tokens;
}

const BINARY_PRECEDENCE: Record<string, number> = {
	"|": 1,
	"^": 2,
	"&": 3,
	"<<": 4,
	">>": 4,
	"+": 5,
	"-": 5,
	"*": 6,
	"/": 6,
	"%": 6,
};

class Parser {
	private pos = 0;

	constructor(
		private readonly tokens: Token[],
		private readonly scope: Scope,
	) {}

	public parse(): number {
		const value = this.parseExpression(0);
		if (this.pos !== this.tokens.length) {
			throw new Error("Unexpected trailing tokens in expression");
		}
		return value;
	}

	private peek(): Token | undefined {
		return this.tokens[this.pos];
	}

	private parseExpression(minPrecedence: number): number {
		let left = this.parseUnary();
		for (;;) {
			const token = this.peek();
			if (!token || token.kind !== "op") break;
			const precedence = BINARY_PRECEDENCE[token.value];
			if (precedence === undefined || precedence < minPrecedence) break;
			this.pos++;
			const right = this.parseExpression(precedence + 1);
			left = this.applyBinary(token.value, left, right);
		}
		return left;
	}

	private parseUnary(): number {
		const token = this.peek();
		if (token && token.kind === "op" && (token.value === "-" || token.value === "~")) {
			this.pos++;
			const operand = this.parseUnary();
			return token.value === "-" ? -operand : (~operand >>> 0);
		}
		return this.parsePrimary();
	}

	private parsePrimary(): number {
		const token = this.peek();
		if (!token) {
			throw new Error("Unexpected end of expression");
		}
		if (token.kind === "num") {
			this.pos++;
			return token.value;
		}
		if (token.kind === "ident") {
			this.pos++;
			// Function call: min(...) / max(...).
			if (this.peek()?.kind === "op" && this.peek()?.value === "(") {
				return this.parseCall(token.value);
			}
			const name = token.value;
			if (!(name in this.scope)) {
				throw new Error(`Unknown identifier "${name}" in expression`);
			}
			return this.scope[name];
		}
		if (token.kind === "op" && token.value === "(") {
			this.pos++;
			const value = this.parseExpression(0);
			this.expect(")");
			return value;
		}
		throw new Error(`Unexpected token "${token.value}" in expression`);
	}

	private parseCall(name: string): number {
		this.expect("(");
		const args: number[] = [];
		if (!(this.peek()?.kind === "op" && this.peek()?.value === ")")) {
			args.push(this.parseExpression(0));
			while (this.peek()?.kind === "op" && this.peek()?.value === ",") {
				this.pos++;
				args.push(this.parseExpression(0));
			}
		}
		this.expect(")");
		switch (name) {
			case "min":
				return Math.min(...args);
			case "max":
				return Math.max(...args);
			default:
				throw new Error(`Unknown function "${name}" in expression`);
		}
	}

	private applyBinary(op: string, a: number, b: number): number {
		switch (op) {
			case "+":
				return a + b;
			case "-":
				return a - b;
			case "*":
				return a * b;
			case "/":
				return Math.trunc(a / b);
			case "%":
				return a % b;
			case "<<":
				return (a << b) >>> 0;
			case ">>":
				return a >>> b;
			case "&":
				return (a & b) >>> 0;
			case "|":
				return (a | b) >>> 0;
			case "^":
				return (a ^ b) >>> 0;
			default:
				throw new Error(`Unknown operator "${op}"`);
		}
	}

	private expect(value: string): void {
		const token = this.peek();
		if (!token || token.kind !== "op" || token.value !== value) {
			throw new Error(`Expected "${value}" in expression`);
		}
		this.pos++;
	}
}

/** Evaluate a whitelisted arithmetic expression against a numeric scope. */
export function evaluateExpression(expression: string, scope: Scope = {}): number {
	return new Parser(tokenize(expression), scope).parse();
}
