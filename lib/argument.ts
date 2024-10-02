import { InvalidArgumentError } from "./error.js";

type ParseArgFunc<T = undefined | unknown> = (value: string, previous: T) => T;
class Argument<
	Usage extends string = "",
	DefaultT = undefined,
	CoerceT = undefined,
	ArgRequired extends boolean | undefined = undefined,
	ChoicesT = undefined,
> {
	description? = "";
	variadic = false;
	parseArg?: ParseArgFunc = undefined;
	required = true;

	defaultValue?: unknown = undefined;
	defaultValueDescription?: string = undefined;
	argChoices?: string[] = undefined;

	#name: string;

	/**
	 * Initialize a new command argument with the given name and description.
	 * The default is that the argument is required, and you can explicitly
	 * indicate this with <> around the name. Put [] around the name for an optional argument.
	 *
	 * @param arg
	 * @param description
	 */
	constructor(arg: Usage, description?: string) {
		this.description = description;

		switch (arg[0]) {
			case "<": // e.g. <required>
				this.required = true;
				this.#name = arg.slice(1, -1);
				break;
			case "[": // e.g. [optional]
				this.required = false;
				this.#name = arg.slice(1, -1);
				break;
			default:
				this.required = true;
				this.#name = arg;
				break;
		}

		if (this.#name.length > 3 && this.#name.slice(-3) === "...") {
			this.variadic = true;
			this.#name = this.#name.slice(0, -3);
		}
	}

	/**
	 * Return argument name.
	 */
	name() {
		return this.#name;
	}

	#concatValue(value: string, previous: string | string[]) {
		if (previous === this.defaultValue || !Array.isArray(previous)) {
			return [value];
		}

		return previous.concat(value);
	}

	/**
	 * Set the default value, and optionally supply the description to be displayed in the help.
	 */
	default<T>(
		value: T,
		description?: string,
	): Argument<Usage, T, CoerceT, ArgRequired, ChoicesT> {
		this.defaultValue = value;
		this.defaultValueDescription = description;
		return this;
	}

	/**
	 * Set the custom handler for processing CLI command arguments into argument values.
	 */
	argParser<T>(
		fn?: ParseArgFunc<T>,
	): Argument<Usage, DefaultT, T, ArgRequired, undefined> {
		this.parseArg = fn as unknown as ParseArgFunc;
		return this;
	}

	/**
	 * Only allow argument value to be one of choices.
	 */
	choices<T extends readonly string[]>(
		values: T,
	): Argument<Usage, DefaultT, undefined, ArgRequired, T[number]> {
		this.argChoices = values.slice();
		this.parseArg = ((arg: string, previous: string) => {
			if (!this.argChoices?.includes(arg)) {
				throw new InvalidArgumentError(
					`Allowed choices are ${this.argChoices?.join(", ")}.`,
				);
			}

			if (this.variadic) {
				return this.#concatValue(arg, previous);
			}
			return arg;
		}) as ParseArgFunc;
		return this;
	}

	/**
	 * Make argument required.
	 */
	argRequired(): Argument<Usage, DefaultT, CoerceT, true, ChoicesT> {
		this.required = true;
		return this;
	}

	/**
	 * Make argument optional.
	 */
	argOptional(): Argument<Usage, DefaultT, CoerceT, false, ChoicesT> {
		this.required = false;
		return this;
	}
}

/**
 * Takes an argument and returns its human readable equivalent for help usage.
 */
function humanReadableArgName(arg: Argument): string {
	const nameOutput = arg.name() + (arg.variadic === true ? "..." : "");

	return arg.required ? `<${nameOutput}>` : `[${nameOutput}]`;
}

export { Argument, humanReadableArgName };
