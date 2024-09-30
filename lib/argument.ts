import { InvalidArgumentError } from "./error.js";

class Argument {
	description = "";
	variadic = false;
	parseArg = undefined;
	defaultValue?: unknown = undefined;
	defaultValueDescription?: string = undefined;
	argChoices?: string[] = undefined;
	required = true;
	#name: string;

	/**
	 * Initialize a new command argument with the given name and description.
	 * The default is that the argument is required, and you can explicitly
	 * indicate this with <> around the name. Put [] around the name for an optional argument.
	 *
	 * @param name
	 * @param description
	 */
	constructor(name: string, description?: string) {
		this.description = description;
		this.variadic = false;
		this.parseArg = undefined;
		this.defaultValue = undefined;
		this.defaultValueDescription = undefined;
		this.argChoices = undefined;

		switch (name[0]) {
			case "<": // e.g. <required>
				this.required = true;
				this.#name = name.slice(1, -1);
				break;
			case "[": // e.g. [optional]
				this.required = false;
				this.#name = name.slice(1, -1);
				break;
			default:
				this.required = true;
				this.#name = name;
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
	default(value: unknown, description?: string): Argument {
		this.defaultValue = value;
		this.defaultValueDescription = description;
		return this;
	}

	/**
	 * Set the custom handler for processing CLI command arguments into argument values.
	 */
	argParser<T>(fn?: (value: string, previous: T) => T): Argument {
		this.parseArg = fn;
		return this;
	}

	/**
	 * Only allow argument value to be one of choices.
	 */
	choices(values: readonly string[]): Argument {
		this.argChoices = values.slice();
		this.parseArg = (arg: string, previous: string) => {
			if (!this.argChoices.includes(arg)) {
				throw new InvalidArgumentError(
					`Allowed choices are ${this.argChoices.join(", ")}.`,
				);
			}

			if (this.variadic) {
				return this.#concatValue(arg, previous);
			}
			return arg;
		};
		return this;
	}

	/**
	 * Make argument required.
	 */
	argRequired(): Argument {
		this.required = true;
		return this;
	}

	/**
	 * Make argument optional.
	 */
	argOptional(): Argument {
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
