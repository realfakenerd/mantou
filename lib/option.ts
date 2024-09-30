const { InvalidArgumentError } = require("./error.js");

class Option {
	flags: string;
	description: string;
	required: boolean;
	optional: boolean;
	variadic: boolean;

	mandatory = false; // The option must have a value after parsing, which usually means it must be specified on command line.;
	negate = false;

	short: string;
	long: string;

	defaultValue = undefined;
	defaultValueDescription = undefined;
	presetArg = undefined;
	envVar = undefined;
	parseArg = undefined;
	hidden = false;
	argChoices = undefined;
	conflictsWith: unknown[] = [];
	implied = undefined;

	/**
	 * Initialize a new `Option` with the given `flags` and `description`.
	 *
	 * @param flags
	 * @param description
	 */

	constructor(flags: string, description?: string) {
		this.flags = flags;
		this.description = description || "";

		this.required = flags.includes("<"); // A value must be supplied when the option is specified.
		this.optional = flags.includes("["); // A value is optional when the option is specified.

		// variadic test ignores <value,...> et al which might be used to describe custom splitting of single argument
		this.variadic = /\w\.\.\.[>\]]$/.test(flags); // The option can take multiple values.

		const optionFlags = splitOptionFlags(flags);
		this.short = optionFlags.shortFlag;
		this.long = optionFlags.longFlag;

		if (this.long) {
			this.negate = this.long.startsWith("--no-");
		}
	}

	/**
	 * Set the default value, and optionally supply the description to be displayed in the help.
	 *
	 * @param value
	 * @param description
	 */
	default(value: unknown, description?: string): Option {
		this.defaultValue = value;
		this.defaultValueDescription = description;
		return this;
	}

	/**
	 * Preset to use when option used without option-argument, especially optional but also boolean and negated.
	 * The custom processing (parseArg) is called.
	 *
	 * @example
	 * new Option('--color').default('GREYSCALE').preset('RGB');
	 * new Option('--donate [amount]').preset('20').argParser(parseFloat);
	 *
	 * @param arg
	 */
	preset(arg: unknown): Option {
		this.presetArg = arg;
		return this;
	}

	/**
	 * Add option name(s) that conflict with this option.
	 * An error will be displayed if conflicting options are found during parsing.
	 *
	 * @example
	 * new Option('--rgb').conflicts('cmyk');
	 * new Option('--js').conflicts(['ts', 'jsx']);
	 *
	 * @param names
	 */
	conflicts(names: string | string[]): Option {
		this.conflictsWith = this.conflictsWith.concat(names);
		return this;
	}

	/**
	 * Specify implied option values for when this option is set and the implied options are not.
	 *
	 * The custom processing (parseArg) is not called on the implied values.
	 *
	 * @example
	 * program
	 *   .addOption(new Option('--log', 'write logging information to file'))
	 *   .addOption(new Option('--trace', 'log extra details').implies({ log: 'trace.txt' }));
	 *
	 * @param impliedOptionValues
	 */
	implies(impliedOptionValues: object): Option {
		let newImplied = impliedOptionValues;
		if (typeof impliedOptionValues === "string") {
			// string is not documented, but easy mistake and we can do what user probably intended.
			newImplied = { [impliedOptionValues]: true };
		}
		this.implied = Object.assign(this.implied || {}, newImplied);
		return this;
	}

	/**
	 * Set environment variable to check for option value.
	 *
	 * An environment variable is only used if when processed the current option value is
	 * undefined, or the source of the current value is 'default' or 'config' or 'env'.
	 *
	 * @param  name
	 */
	env(name: string): Option {
		this.envVar = name;
		return this;
	}

	/**
	 * Set the custom handler for processing CLI option arguments into option values.
	 *
	 * @param fn
	 */
	argParser(fn?: () => void): Option {
		this.parseArg = fn;
		return this;
	}

	/**
	 * Whether the option is mandatory and must have a value after parsing.
	 *
	 * @param mandatory
	 */
	makeOptionMandatory(mandatory = true): Option {
		this.mandatory = !!mandatory;
		return this;
	}

	/**
	 * Hide option in help.
	 *
	 * @param hide
	 */
	hideHelp(hide = true): Option {
		this.hidden = !!hide;
		return this;
	}

	/**
	 * @package
	 */
	_concatValue(value: string, previous: string | string[]) {
		if (previous === this.defaultValue || !Array.isArray(previous)) {
			return [value];
		}

		return previous.concat(value);
	}

	/**
	 * Only allow option value to be one of choices.
	 *
	 * @param values
	 */
	choices(values: string[]): Option {
		this.argChoices = values.slice();
		this.parseArg = (arg: string, previous: string) => {
			if (!this.argChoices.includes(arg)) {
				throw new InvalidArgumentError(
					`Allowed choices are ${this.argChoices.join(", ")}.`,
				);
			}
			if (this.variadic) {
				return this._concatValue(arg, previous);
			}
			return arg;
		};
		return this;
	}

	/**
	 * Return option name.
	 *
	 */
	name(): string {
		if (this.long) {
			return this.long.replace(/^--/, "");
		}
		return this.short.replace(/^-/, "");
	}

	/**
	 * Return option name, in a camelcase format that can be used
	 * as a object attribute key.
	 */
	attributeName(): string {
		return camelcase(this.name().replace(/^no-/, ""));
	}

	/**
	 * Check if `arg` matches the short or long flag.
	 *
	 * @param arg
	 * @package
	 */
	is(arg: string): boolean {
		return this.short === arg || this.long === arg;
	}

	/**
	 * Return whether a boolean option.
	 *
	 * Options are one of boolean, negated, required argument, or optional argument.
	 *
	 * @package
	 */
	isBoolean(): boolean {
		return !this.required && !this.optional && !this.negate;
	}
}

/**
 * This class is to make it easier to work with dual options, without changing the existing
 * implementation. We support separate dual options for separate positive and negative options,
 * like `--build` and `--no-build`, which share a single option value. This works nicely for some
 * use cases, but is tricky for others where we want separate behaviours despite
 * the single shared option value.
 */
class DualOptions {
	positiveOptions = new Map<string, Option>();
	negativeOptions = new Map<string, Option>();
	dualOptions = new Set<string>();

	constructor(options: Option[]) {
		this.positiveOptions = new Map();
		this.negativeOptions = new Map();
		this.dualOptions = new Set();

		for (const option of options) {
			if (option.negate) {
				this.negativeOptions.set(option.attributeName(), option);
			} else {
				this.positiveOptions.set(option.attributeName(), option);
			}
		}

		this.negativeOptions.forEach((_, key) => {
			if (this.positiveOptions.has(key)) {
				this.dualOptions.add(key);
			}
		});
	}

	/**
	 * Did the value come from the option, and not from possible matching dual option?
	 *
	 * @param value
	 * @param option
	 */
	valueFromOption(value: unknown, option: Option): boolean {
		const optionKey = option.attributeName();
		if (!this.dualOptions.has(optionKey)) return true;

		// Use the value to deduce if (probably) came from the option.
		const preset = this.negativeOptions.get(optionKey).presetArg;
		const negativeValue = preset !== undefined ? preset : false;
		return option.negate === (negativeValue === value);
	}
}

/**
 * Convert string from kebab-case to camelCase.
 */
function camelcase(str: string) {
	return str.split("-").reduce((str, word) => {
		return str + word[0].toUpperCase() + word.slice(1);
	});
}

/**
 * Split the short and long flag out of something like '-m,--mixed <value>'
 */
function splitOptionFlags(flags: string) {
	let shortFlag: string;
	let longFlag: string;

	// Use original very loose parsing to maintain backwards compatibility for now,
	// which allowed for example unintended `-sw, --short-word` [sic].
	const flagParts = flags.split(/[ |,]+/);
	if (flagParts.length > 1 && !/^[[<]/.test(flagParts[1]))
		shortFlag = flagParts.shift();
	longFlag = flagParts.shift();
	// Add support for lone short flag without significantly changing parsing!
	if (!shortFlag && /^-[^-]$/.test(longFlag)) {
		shortFlag = longFlag;
		longFlag = undefined;
	}
	return { shortFlag, longFlag };
}

export { Option, DualOptions };
