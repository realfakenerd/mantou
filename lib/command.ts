import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import type {
	AddHelpTextContext,
	AddHelpTextPosition,
	CommandOptions,
	CommandUnknownOpts,
	ExecutableCommandOptions,
	HelpConfiguration,
	HelpContext,
	HookEvent,
	HookEventListener,
	OptionValues,
	OutputConfiguration,
	ParseOptionsResult,
	InferCommmandArguments,
	InferArgument,
} from "../typings/index";
import { Argument, humanReadableArgName } from "./argument";
import { CommanderError } from "./error";
import { Help } from "./help";
import { DualOptions, Option } from "./option";
import { suggestSimilar } from "./suggestSimilar";

class Command<
	Args extends unknown[] = [],
	Opts extends OptionValues = Record<string, unknown>,
> extends EventEmitter {
	args: string[] = []; // cli args with options removed
	processedArgs: Args = []; // like .args but after custom processing and collecting variadic
	readonly commands: CommandUnknownOpts[] = [];
	readonly options: Option[] = [];
	readonly registeredArguments: Argument[] = [];
	parent: Command | null = null;

	rawArgs: unknown[] = [];

	_allowUnknownOption = false;
	_allowExcessArguments = true;
	_args: unknown = this.registeredArguments;
	#scriptPath: string | null = null;
	_name = "";
	#optionValues: OptionValues = {};
	_optionValueSources = {};
	_storeOptionsAsProperties = false;
	_actionHandler: unknown = null;
	_executableHandler: unknown = null;
	_executableFile: unknown = null;
	#executableDir: string | null = null;
	_defaultCommandName: unknown = null;
	#exitCallback: ((err: CommanderError) => void) | null = null;
	_aliases: string[] = [];
	_combineFlagAndOptionalValue = true;
	#description: string | undefined = undefined;
	#summary: string | undefined = undefined;
	_argsDescription?: Record<string, string> = undefined;
	_enablePositionalOptions = false;
	_passThroughOptions = false;
	#lifeCycleHooks = {
		postAction: null,
		preAction: null,
		preSubcommand: null,
	};
	#showHelpAfterError: string | boolean = false;
	#showSuggestionAfterError = true;

	#outputConfiguration = {
		writeOut: (str: string) => process.stdout.write(str),
		writeErr: (str: string) => process.stderr.write(str),
		getOutHelpWidth: () =>
			process.stdout.isTTY ? process.stdout.columns : undefined,
		getErrHelpWidth: () =>
			process.stderr.isTTY ? process.stderr.columns : undefined,
		outputError: (str: string, write: (str: string) => void) => write(str),
	} satisfies OutputConfiguration;

	/** @package */
	_hidden = false;
	_helpOption: Option | null | undefined = undefined;
	#addImplicitHelpCommand?: boolean = undefined;
	#helpCommand: Command | undefined = undefined;
	_helpConfiguration = {};
	#versionOptionName: unknown;
	#version: unknown;
	#usage: string | undefined = undefined;

	runningCommand: unknown;

	/**
	 * Initialize a new `Command`.
	 */
	constructor(name = "") {
		super();
		this._name = name || "";
	}

	/**
	 * Copy settings that are useful to have in common across root command and subcommands.
	 *
	 * (Used internally when adding a command using `.command()` so subcommands inherit parent settings.)
	 *
	 * @return `this` command for chaining
	 */
	copyInheritedSettings(sourceCommand: CommandUnknownOpts): this {
		this.#outputConfiguration = sourceCommand.#outputConfiguration;
		this._helpOption = sourceCommand._helpOption;
		this.#helpCommand = sourceCommand.#helpCommand;
		this._helpConfiguration = sourceCommand._helpConfiguration;
		this.#exitCallback = sourceCommand.#exitCallback;
		this._storeOptionsAsProperties = sourceCommand._storeOptionsAsProperties;
		this._combineFlagAndOptionalValue =
			sourceCommand._combineFlagAndOptionalValue;
		this._allowExcessArguments = sourceCommand._allowExcessArguments;
		this._enablePositionalOptions = sourceCommand._enablePositionalOptions;
		this.#showHelpAfterError = sourceCommand.#showHelpAfterError;
		this.#showSuggestionAfterError = sourceCommand.#showSuggestionAfterError;

		return this;
	}

	#getCommandAndAncestors(): Command[] {
		const result: Command[] = [];

		let command = this;
		for (command; command; command = command.parent) {
			result.push(command as unknown as Command);
		}
		return result;
	}

	/**
	 * Define a command, implemented using an action handler.
	 *
	 * @remarks
	 * The command description is supplied using `.description`, not as a parameter to `.command`.
	 *
	 * @example
	 * ```ts
	 * program
	 *   .command('clone <source> [destination]')
	 *   .description('clone a repository into a newly created directory')
	 *   .action((source, destination) => {
	 *     console.log('clone command called');
	 *   });
	 * ```
	 *
	 * @param nameAndArgs - command name and arguments, args are  `<required>` or `[optional]` and last may also be `variadic...`
	 * @param opts - configuration options
	 * @returns new command
	 */
	command<Usage extends string>(
		nameAndArgs: Usage,
		opts?: CommandOptions,
	): Command<[...InferCommmandArguments<Usage>]>;
	/**
	 * Define a command, implemented in a separate executable file.
	 *
	 * @remarks
	 * The command description is supplied as the second parameter to `.command`.
	 *
	 * @example
	 * ```ts
	 *  program
	 *    .command('start <service>', 'start named service')
	 *    .command('stop [service]', 'stop named service, or all if no name supplied');
	 * ```
	 *
	 * @param nameAndArgs - command name and arguments, args are  `<required>` or `[optional]` and last may also be `variadic...`
	 * @param description - description of executable command
	 * @param opts - configuration options
	 * @returns `this` command for chaining
	 */
	command(
		nameAndArgs: string,
		description?: string,
		opts?: ExecutableCommandOptions,
	): Command {
		let desc = description;
		let _opts = opts;

		if (typeof desc === "object" && desc !== null) {
			_opts = desc;
			desc = undefined;
		}
		_opts = _opts || {};
		const [, name, args] = nameAndArgs.match(/([^ ]+) *(.*)/);

		const cmd = this.createCommand(name);
		if (desc) {
			cmd.description(desc as string);
			cmd._executableHandler = true;
		}
		if (_opts.isDefault) this._defaultCommandName = cmd._name;
		cmd._hidden = !!(_opts.noHelp || _opts.hidden); // noHelp is deprecated old name for hidden
		cmd._executableFile = _opts.executableFile || null; // Custom name for executable file, set missing to null to match constructor
		if (args) cmd.arguments(args);
		this.#registerCommand(cmd);
		cmd.parent = this;
		cmd.copyInheritedSettings(this);

		if (desc) return this;
		return cmd;
	}

	/**
	 * Factory routine to create a new unattached command.
	 *
	 * See .command() for creating an attached subcommand, which uses this routine to
	 * create the command. You can override createCommand to customise subcommands.
	 *
	 * @param name
	 * @return new command
	 */

	createCommand(name?: string): Command {
		return new Command(name);
	}

	/**
	 * You can customise the help with a subclass of Help by overriding createHelp,
	 * or by overriding Help properties using configureHelp().
	 */
	createHelp(): Help {
		return Object.assign(new Help(), this.configureHelp());
	}

	/**
	 * You can customise the help by overriding Help properties using configureHelp(),
	 * or with a subclass of Help by overriding createHelp().
	 * @param configuration - configuration options
	 * @return `this` command for chaining, or stored configuration
	 */
	configureHelp(): HelpConfiguration;
	configureHelp(configuration?: HelpConfiguration): this | HelpConfiguration {
		if (configuration === undefined) return this._helpConfiguration;

		this._helpConfiguration = configuration;
		return this;
	}

	/**
	 * The default output goes to stdout and stderr. You can customise this for special
	 * applications. You can also customise the display of errors by overriding outputError.
	 *
	 * The configuration properties are all functions:
	 *
	 *     // functions to change where being written, stdout and stderr
	 *     writeOut(str)
	 *     writeErr(str)
	 *     // matching functions to specify width for wrapping help
	 *     getOutHelpWidth()
	 *     getErrHelpWidth()
	 *     // functions based on what is being written out
	 *     outputError(str, write) // used for displaying errors, and not used for displaying help
	 *
	 * @param configuration - configuration options
	 * @return `this` command for chaining, or stored configuration
	 */
	configureOutput(): OutputConfiguration;
	configureOutput(
		configuration?: HelpConfiguration,
	): this | OutputConfiguration {
		if (configuration === undefined) return this.#outputConfiguration;

		Object.assign(this.#outputConfiguration, configuration);
		return this;
	}

	/**
	 * Display the help or a custom message after an error occurs.	 *
	 * @return `this` command for chaining
	 */
	showHelpAfterError(displayHelp: boolean | string = true): this {
		let _displayHelp = displayHelp;

		if (typeof _displayHelp !== "string") _displayHelp = !!_displayHelp;
		this.#showHelpAfterError = _displayHelp;
		return this;
	}

	/**
	 * Display suggestion of similar commands for unknown commands, or options for unknown options.
	 *
	 * @return `this` command for chaining
	 */
	showSuggestionAfterError(displaySuggestion = true): this {
		this.#showSuggestionAfterError = !!displaySuggestion;
		return this;
	}

	/**
	 * Add a prepared subcommand.
	 *
	 * See .command() for creating an attached subcommand which inherits settings from its parent.
	 *
	 * @param cmd - new subcommand
	 * @param opts - configuration options
	 * @return `this` command for chaining
	 */
	addCommand(cmd: CommandUnknownOpts, opts: CommandOptions = {}): this {
		if (!cmd.#name) {
			throw new Error(`Command passed to .addCommand() must have a name
- specify the name in Command constructor or using .name()`);
		}

		if (opts.isDefault) this._defaultCommandName = cmd.#name;
		if (opts.noHelp || opts.hidden) cmd._hidden = true; // modifying passed command due to existing implementation

		this.#registerCommand(cmd);
		cmd.parent = this;
		cmd.#checkForBrokenPassThrough();

		return this;
	}

	/**
	 * Factory routine to create a new unattached argument.
	 *
	 * See .argument() for creating an attached argument, which uses this routine to
	 * create the argument. You can override createArgument to return a custom argument.
	 *
	 * @return new argument
	 */

	createArgument<Usage extends string>(
		name: Usage,
		description?: string,
	): Argument<Usage> {
		return new Argument(name, description);
	}

	/**
	 * Define argument syntax for command.
	 *
	 * The default is that the argument is required, and you can explicitly
	 * indicate this with <> around the name. Put [] around the name for an optional argument.
	 *
	 * @example
	 * program.argument('<input-file>');
	 * program.argument('[output-file]');
	 *
	 * @param fn - custom argument processing function
	 * @return `this` command for chaining
	 */
	argument<S extends string, T>(
		flags: S,
		description: string,
		fn: (value: string, previous: T) => T,
	): Command<[...Args, InferArgument<S, undefined, T>], Opts>;
	argument<S extends string, T>(
		flags: S,
		description: string,
		fn: (value: string, previous: T) => T,
		defaultValue: T,
	): Command<[...Args, InferArgument<S, T, T>], Opts>;
	argument<S extends string>(
		usage: S,
		description?: string,
	): Command<[...Args, InferArgument<S, undefined>], Opts>;
	argument<S extends string, DefaultT>(
		name: S,
		description?: string,
		fn?: (value: string, previous: DefaultT) => DefaultT,
		defaultValue?: DefaultT,
	): Command<[...Args, InferArgument<S, DefaultT>], Opts> {
		const argument = this.createArgument(name, description);
		if (typeof fn === "function") {
			argument.default(defaultValue).argParser(fn);
		} else {
			argument.default(fn);
		}
		this.addArgument(argument);

		// biome-ignore lint/suspicious/noExplicitAny: <explanation>
		return this as any;
	}

	/**
	 * Define argument syntax for command, adding multiple at once (without descriptions).
	 *
	 * See also .argument().
	 *
	 * @example
	 * program.arguments('<cmd> [env]');
	 *
	 * @param names
	 * @return `this` command for chaining
	 */
	arguments<Names extends string>(names: Names) {
		for (const detail of names.trim().split(/ +/)) {
			this.argument(detail);
		}

		return this as unknown as Command<[...Args, ...InferArgument<Names>], Opts>;
	}

	/**
	 * Define argument syntax for command, adding a prepared argument.
	 *
	 * @return `this` command for chaining
	 */
	addArgument<
		Usage extends string,
		DefaultT,
		CoerceT,
		ArgRequired extends boolean | undefined,
		ChoicesT,
	>(arg: Argument<Usage, DefaultT, CoerceT, ArgRequired, ChoicesT>) {
		const previousArgument = this.registeredArguments.slice(-1)[0];
		if (previousArgument?.variadic) {
			throw new Error(
				`only the last argument can be variadic '${previousArgument.name()}'`,
			);
		}
		if (
			arg.required &&
			arg.defaultValue !== undefined &&
			arg.parseArg === undefined
		) {
			throw new Error(
				`a default value for a required argument is never used: '${arg.name()}'`,
			);
		}
		this.registeredArguments.push(arg);
		return this as unknown as Command<
			[...Args, InferArgument<Usage, DefaultT, CoerceT, ArgRequired, ChoicesT>],
			Opts
		>;
	}

	/**
	 * Customise or override default help command. By default a help command is automatically added if your command has subcommands.
	 *
	 * @example
	 *    program.helpCommand('help [cmd]');
	 *    program.helpCommand('help [cmd]', 'show help');
	 *    program.helpCommand(false); // suppress default help command
	 *    program.helpCommand(true); // add help command even if no subcommands
	 *
	 * @param enableOrNameAndArgs - enable with custom name and/or arguments, or boolean to override whether added
	 * @param description - custom description
	 * @return `this` command for chaining
	 */
	helpCommand(enableOrNameAndArgs: boolean): this;
	helpCommand(
		enableOrNameAndArgs: string | boolean,
		description?: string,
	): this {
		if (typeof enableOrNameAndArgs === "boolean") {
			this.#addImplicitHelpCommand = enableOrNameAndArgs;
			return this;
		}

		enableOrNameAndArgs = enableOrNameAndArgs ?? "help [command]";
		const [, helpName, helpArgs] = enableOrNameAndArgs.match(/([^ ]+) *(.*)/);
		const helpDescription = description ?? "display help for command";

		const helpCommand = this.createCommand(helpName);
		helpCommand.helpOption(false);
		if (helpArgs) helpCommand.arguments(helpArgs);
		if (helpDescription) helpCommand.description(helpDescription);

		this.#addImplicitHelpCommand = true;
		this.#helpCommand = helpCommand;

		return this;
	}

	/**
	 * Add prepared custom help command.
	 *
	 * @param helpCommand - custom help command, or deprecated enableOrNameAndArgs as for `.helpCommand()`
	 * @param deprecatedDescription - deprecated custom description used with custom name only
	 * @return `this` command for chaining
	 */
	addHelpCommand(cmd: Command): this;
	addHelpCommand(enable: boolean): this;
	addHelpCommand(helpCommand: string | boolean | Command): this {
		// If not passed an object, call through to helpCommand for backwards compatibility,
		// as addHelpCommand was originally used like helpCommand is now.
		if (typeof helpCommand !== "object") {
			this.helpCommand(helpCommand as boolean);
			return this;
		}

		this.#addImplicitHelpCommand = true;
		this.#helpCommand = helpCommand;
		return this;
	}

	/**
	 * Lazy create help command.
	 *
	 * @package
	 */
	_getHelpCommand(): Command | null {
		const hasImplicitHelpCommand =
			this.#addImplicitHelpCommand ??
			(this.commands.length &&
				!this._actionHandler &&
				!this.#findCommand("help"));

		if (hasImplicitHelpCommand) {
			if (this.#helpCommand === undefined) {
				this.helpCommand(undefined, undefined); // use default name and description
			}
			return this.#helpCommand;
		}
		return null;
	}

	/**
	 * Add hook for life cycle event.
	 *
	 * @return `this` command for chaining
	 */

	hook(event: HookEvent, listener: HookEventListener | Promise<void>): this {
		const allowedValues = ["preSubcommand", "preAction", "postAction"];
		if (!allowedValues.includes(event)) {
			throw new Error(`Unexpected value for event passed to hook : '${event}'.
Expecting one of '${allowedValues.join("', '")}'`);
		}
		if (this.#lifeCycleHooks[event]) {
			this.#lifeCycleHooks[event].push(listener);
		} else {
			this.#lifeCycleHooks[event] = [listener];
		}
		return this;
	}

	/**
	 * Register callback to use as replacement for calling process.exit.
	 *
	 * @param fn optional callback which will be passed a CommanderError, defaults to throwing
	 * @return `this` command for chaining
	 */
	exitOverride(fn?: (err: CommanderError) => never | undefined): this {
		if (fn) {
			this.#exitCallback = fn;
		} else {
			this.#exitCallback = (err: CommanderError) => {
				if (err.code !== "commander.executeSubCommandAsync") {
					throw err;
				} else {
					// Async callback from spawn events, not useful to throw.
				}
			};
		}
		return this;
	}

	/**
	 * Call process.exit, and _exitCallback if defined.
	 *
	 * @param {number} exitCode exit code for using with process.exit
	 * @param {string} code an id string representing the error
	 * @param {string} message human-readable description of the error
	 * @return never
	 */
	#exit(exitCode: number, code: string, message: string) {
		if (this.#exitCallback) {
			this.#exitCallback(new CommanderError(exitCode, code, message));
			// Expecting this line is not reached.
		}
		process.exit(exitCode);
	}

	/**
	 * Register callback `fn` for the command.
	 *
	 * @example
	 * program
	 *   .command('serve')
	 *   .description('start service')
	 *   .action(function() {
	 *      // do work here
	 *   });
	 *
	 * @return `this` command for chaining
	 */
	action(
		fn: (
			this: this,
			...args: [...Args, Opts, this]
		) => undefined | Promise<undefined>,
	): this {
		const listener = (args: [...Args, Opts, this]) => {
			// The .action callback takes an extra parameter which is the command or options.
			const expectedArgsCount = this.registeredArguments.length;
			const actionArgs = args.slice(0, expectedArgsCount);
			if (this._storeOptionsAsProperties) {
				actionArgs[expectedArgsCount] = this; // backwards compatible "options"
			} else {
				actionArgs[expectedArgsCount] = this.opts();
			}
			actionArgs.push(this);

			return fn.apply(this, actionArgs as [...Args, Opts, this]);
		};
		this._actionHandler = listener;
		return this;
	}

	/**
	 * Factory routine to create a new unattached option.
	 *
	 * See .option() for creating an attached option, which uses this routine to
	 * create the option. You can override createOption to return a custom option.
	 *
	 * @return new option
	 */

	createOption<Usage extends string>(
		flags: Usage,
		description?: string,
	): Option<Usage> {
		return new Option(flags, description);
	}

	/**
	 * Wrap parseArgs to catch 'commander.invalidArgument'.
	 */
	#callParseArg(
		target: Option | Argument,
		value: string,
		previous: unknown,
		invalidArgumentMessage: string,
	) {
		try {
			return target.parseArg(value, previous);
		} catch (err) {
			if (err.code === "commander.invalidArgument") {
				const message = `${invalidArgumentMessage} ${err.message}`;
				this.error(message, { exitCode: err.exitCode, code: err.code });
			}
			throw err;
		}
	}

	/**
	 * Check for option flag conflicts.
	 * Register option if no conflicts found, or throw on conflict.
	 */
	#registerOption(option: Option) {
		const matchingOption =
			(option.short && this._findOption(option.short)) ||
			(option.long && this._findOption(option.long));
		if (matchingOption) {
			const matchingFlag =
				option.long && this._findOption(option.long)
					? option.long
					: option.short;
			throw new Error(`Cannot add option '${option.flags}'${this._name && ` to command '${this._name}'`} due to conflicting flag '${matchingFlag}'
-  already used by option '${matchingOption.flags}'`);
		}

		this.options.push(option);
	}

	/**
	 * Check for command name and alias conflicts with existing commands.
	 * Register command if no conflicts found, or throw on conflict.
	 *
	 * @param {Command} command
	 * @private
	 */

	#registerCommand(command: Command) {
		const knownBy = (cmd) => {
			return [cmd.name()].concat(cmd.aliases());
		};

		const alreadyUsed = knownBy(command).find((name) =>
			this.#findCommand(name),
		);
		if (alreadyUsed) {
			const existingCmd = knownBy(this.#findCommand(alreadyUsed)).join("|");
			const newCmd = knownBy(command).join("|");
			throw new Error(
				`cannot add command '${newCmd}' as already have command '${existingCmd}'`,
			);
		}

		this.commands.push(command);
	}

	/**
	 * Add an option.
	 *
	 * @param {Option} option
	 * @return {Command} `this` command for chaining
	 */
	addOption(option: Option): Command {
		this.#registerOption(option);

		const oname = option.name();
		const name = option.attributeName();

		// store default value
		if (option.negate) {
			// --no-foo is special and defaults foo to true, unless a --foo option is already defined
			const positiveLongFlag = option.long.replace(/^--no-/, "--");
			if (!this._findOption(positiveLongFlag)) {
				this.setOptionValueWithSource(
					name,
					option.defaultValue === undefined ? true : option.defaultValue,
					"default",
				);
			}
		} else if (option.defaultValue !== undefined) {
			this.setOptionValueWithSource(name, option.defaultValue, "default");
		}

		// handler for cli and env supplied values
		const handleOptionValue = (val, invalidValueMessage, valueSource) => {
			// val is null for optional option used without an optional-argument.
			// val is undefined for boolean and negated option.
			if (val == null && option.presetArg !== undefined) {
				val = option.presetArg;
			}

			// custom processing
			const oldValue = this.getOptionValue(name);
			if (val !== null && option.parseArg) {
				val = this.#callParseArg(option, val, oldValue, invalidValueMessage);
			} else if (val !== null && option.variadic) {
				val = option.#concatValue(val, oldValue);
			}

			// Fill-in appropriate missing values. Long winded but easy to follow.
			if (val == null) {
				if (option.negate) {
					val = false;
				} else if (option.isBoolean() || option.optional) {
					val = true;
				} else {
					val = ""; // not normal, parseArg might have failed or be a mock function for testing
				}
			}
			this.setOptionValueWithSource(name, val, valueSource);
		};

		this.on("option:" + oname, (val) => {
			const invalidValueMessage = `error: option '${option.flags}' argument '${val}' is invalid.`;
			handleOptionValue(val, invalidValueMessage, "cli");
		});

		if (option.envVar) {
			this.on("optionEnv:" + oname, (val) => {
				const invalidValueMessage = `error: option '${option.flags}' value '${val}' from env '${option.envVar}' is invalid.`;
				handleOptionValue(val, invalidValueMessage, "env");
			});
		}

		return this;
	}

	/**
	 * Internal implementation shared by .option() and .requiredOption()
	 *
	 * @return {Command} `this` command for chaining
	 * @private
	 */
	_optionEx(config, flags, description, fn, defaultValue): Command {
		if (typeof flags === "object" && flags instanceof Option) {
			throw new Error(
				"To add an Option object use addOption() instead of option() or requiredOption()",
			);
		}
		const option = this.createOption(flags, description);
		option.makeOptionMandatory(!!config.mandatory);
		if (typeof fn === "function") {
			option.default(defaultValue).argParser(fn);
		} else if (fn instanceof RegExp) {
			// deprecated
			const regex = fn;
			fn = (val, def) => {
				const m = regex.exec(val);
				return m ? m[0] : def;
			};
			option.default(defaultValue).argParser(fn);
		} else {
			option.default(fn);
		}

		return this.addOption(option);
	}

	/**
	 * Define option with `flags`, `description`, and optional argument parsing function or `defaultValue` or both.
	 *
	 * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space. A required
	 * option-argument is indicated by `<>` and an optional option-argument by `[]`.
	 *
	 * See the README for more details, and see also addOption() and requiredOption().
	 *
	 * @example
	 * program
	 *     .option('-p, --pepper', 'add pepper')
	 *     .option('-p, --pizza-type <TYPE>', 'type of pizza') // required option-argument
	 *     .option('-c, --cheese [CHEESE]', 'add extra cheese', 'mozzarella') // optional option-argument with default
	 *     .option('-t, --tip <VALUE>', 'add tip to purchase cost', parseFloat) // custom parse function
	 *
	 * @param {string} flags
	 * @param {string} [description]
	 * @param {(Function|*)} [parseArg] - custom option processing function or default value
	 * @param {*} [defaultValue]
	 * @return {Command} `this` command for chaining
	 */

	option(
		flags: string,
		description: string,
		parseArg: Function | unknown,
		defaultValue: unknown,
	): Command {
		return this._optionEx({}, flags, description, parseArg, defaultValue);
	}

	/**
	 * Add a required option which must have a value after parsing. This usually means
	 * the option must be specified on the command line. (Otherwise the same as .option().)
	 *
	 * The `flags` string contains the short and/or long flags, separated by comma, a pipe or space.
	 *
	 * @param {string} flags
	 * @param {string} [description]
	 * @param {(Function|*)} [parseArg] - custom option processing function or default value
	 * @param {*} [defaultValue]
	 * @return {Command} `this` command for chaining
	 */

	requiredOption(
		flags: string,
		description: string,
		parseArg: Function | unknown,
		defaultValue: unknown,
	): Command {
		return this._optionEx(
			{ mandatory: true },
			flags,
			description,
			parseArg,
			defaultValue,
		);
	}

	/**
	 * Alter parsing of short flags with optional values.
	 *
	 * @example
	 * // for `.option('-f,--flag [value]'):
	 * program.combineFlagAndOptionalValue(true);  // `-f80` is treated like `--flag=80`, this is the default behaviour
	 * program.combineFlagAndOptionalValue(false) // `-fb` is treated like `-f -b`
	 *
	 * @param {boolean} [combine] - if `true` or omitted, an optional value can be specified directly after the flag.
	 * @return {Command} `this` command for chaining
	 */
	combineFlagAndOptionalValue(combine: boolean = true): Command {
		this._combineFlagAndOptionalValue = !!combine;
		return this;
	}

	/**
	 * Allow unknown options on the command line.
	 *
	 * @param {boolean} [allowUnknown] - if `true` or omitted, no error will be thrown for unknown options.
	 * @return {Command} `this` command for chaining
	 */
	allowUnknownOption(allowUnknown: boolean = true): Command {
		this._allowUnknownOption = !!allowUnknown;
		return this;
	}

	/**
	 * Allow excess command-arguments on the command line. Pass false to make excess arguments an error.
	 *
	 * @param {boolean} [allowExcess] - if `true` or omitted, no error will be thrown for excess arguments.
	 * @return {Command} `this` command for chaining
	 */
	allowExcessArguments(allowExcess: boolean = true): Command {
		this._allowExcessArguments = !!allowExcess;
		return this;
	}

	/**
	 * Enable positional options. Positional means global options are specified before subcommands which lets
	 * subcommands reuse the same option names, and also enables subcommands to turn on passThroughOptions.
	 * The default behaviour is non-positional and global options may appear unknownwhere on the command line.
	 *
	 * @param {boolean} [positional]
	 * @return {Command} `this` command for chaining
	 */
	enablePositionalOptions(positional: boolean = true): Command {
		this._enablePositionalOptions = !!positional;
		return this;
	}

	/**
	 * Pass through options that come after command-arguments rather than treat them as command-options,
	 * so actual command-options come before command-arguments. Turning this on for a subcommand requires
	 * positional options to have been enabled on the program (parent commands).
	 * The default behaviour is non-positional and options may appear before or after command-arguments.
	 *
	 * @param {boolean} [passThrough] for unknown options.
	 * @return {Command} `this` command for chaining
	 */
	passThroughOptions(passThrough: boolean = true): Command {
		this._passThroughOptions = !!passThrough;
		this.#checkForBrokenPassThrough();
		return this;
	}

	/**
	 * @private
	 */

	#checkForBrokenPassThrough() {
		if (
			this.parent &&
			this._passThroughOptions &&
			!this.parent._enablePositionalOptions
		) {
			throw new Error(
				`passThroughOptions cannot be used for '${this._name}' without turning on enablePositionalOptions for parent command(s)`,
			);
		}
	}

	/**
	 * Whether to store option values as properties on command object,
	 * or store separately (specify false). In both cases the option values can be accessed using .opts().
	 *
	 * @param {boolean} [storeAsProperties=true]
	 * @return {Command} `this` command for chaining
	 */

	storeOptionsAsProperties(storeAsProperties: boolean = true): Command {
		if (this.options.length) {
			throw new Error("call .storeOptionsAsProperties() before adding options");
		}
		if (Object.keys(this.#optionValues).length) {
			throw new Error(
				"call .storeOptionsAsProperties() before setting option values",
			);
		}
		this._storeOptionsAsProperties = !!storeAsProperties;
		return this;
	}

	/**
	 * Retrieve option value.
	 *
	 * @param {string} key
	 * @return {object} value
	 */

	getOptionValue(key: string): object {
		if (this._storeOptionsAsProperties) {
			return this[key];
		}
		return this.#optionValues[key];
	}

	/**
	 * Store option value.
	 *
	 * @param {string} key
	 * @param {object} value
	 * @return {Command} `this` command for chaining
	 */

	setOptionValue(key: string, value: object): Command {
		return this.setOptionValueWithSource(key, value, undefined);
	}

	/**
	 * Store option value and where the value came from.
	 *
	 * @param {string} key
	 * @param {object} value
	 * @param {string} source - expected values are default/config/env/cli/implied
	 * @return {Command} `this` command for chaining
	 */

	setOptionValueWithSource(
		key: string,
		value: object,
		source: string,
	): Command {
		if (this._storeOptionsAsProperties) {
			this[key] = value;
		} else {
			this.#optionValues[key] = value;
		}
		this._optionValueSources[key] = source;
		return this;
	}

	/**
	 * Get source of option value.
	 * Expected values are default | config | env | cli | implied
	 *
	 * @param {string} key
	 * @return {string}
	 */

	getOptionValueSource(key: string): string {
		return this._optionValueSources[key];
	}

	/**
	 * Get source of option value. See also .optsWithGlobals().
	 * Expected values are default | config | env | cli | implied
	 *
	 * @param {string} key
	 * @return {string}
	 */

	getOptionValueSourceWithGlobals(key: string): string {
		// global overwrites local, like optsWithGlobals
		let source;
		this.#getCommandAndAncestors().forEach((cmd) => {
			if (cmd.getOptionValueSource(key) !== undefined) {
				source = cmd.getOptionValueSource(key);
			}
		});
		return source;
	}

	/**
	 * Get user arguments from implied or explicit arguments.
	 * Side-effects: set _scriptPath if args included script. Used for default program name, and subcommand searches.
	 *
	 * @private
	 */

	_prepareUserArgs(argv, parseOptions) {
		if (argv !== undefined && !Array.isArray(argv)) {
			throw new Error("first parameter to parse must be array or undefined");
		}
		parseOptions = parseOptions || {};

		// auto-detect argument conventions if nothing supplied
		if (argv === undefined && parseOptions.from === undefined) {
			if (process.versions?.electron) {
				parseOptions.from = "electron";
			}
			// check node specific options for scenarios where user CLI args follow executable without scriptname
			const execArgv = process.execArgv ?? [];
			if (
				execArgv.includes("-e") ||
				execArgv.includes("--eval") ||
				execArgv.includes("-p") ||
				execArgv.includes("--print")
			) {
				parseOptions.from = "eval"; // internal usage, not documented
			}
		}

		// default to using process.argv
		if (argv === undefined) {
			argv = process.argv;
		}
		this.rawArgs = argv.slice();

		// extract the user args and scriptPath
		let userArgs;
		switch (parseOptions.from) {
			case undefined:
			case "node":
				this.#scriptPath = argv[1];
				userArgs = argv.slice(2);
				break;
			case "electron":
				// @ts-ignore: because defaultApp is an unknown property
				if (process.defaultApp) {
					this.#scriptPath = argv[1];
					userArgs = argv.slice(2);
				} else {
					userArgs = argv.slice(1);
				}
				break;
			case "user":
				userArgs = argv.slice(0);
				break;
			case "eval":
				userArgs = argv.slice(1);
				break;
			default:
				throw new Error(
					`unexpected parse option { from: '${parseOptions.from}' }`,
				);
		}

		// Find default name for program from arguments.
		if (!this._name && this.#scriptPath)
			this.nameFromFilename(this.#scriptPath);
		this._name = this._name || "program";

		return userArgs;
	}

	/**
	 * Parse `argv`, setting options and invoking commands when defined.
	 *
	 * Use parseAsync instead of parse if unknown of your action handlers are async.
	 *
	 * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
	 *
	 * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
	 * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
	 * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
	 * - `'user'`: just user arguments
	 *
	 * @example
	 * program.parse(); // parse process.argv and auto-detect electron and special node flags
	 * program.parse(process.argv); // assume argv[0] is app and argv[1] is script
	 * program.parse(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
	 *
	 * @param {string[]} [argv] - optional, defaults to process.argv
	 * @param {object} [parseOptions] - optionally specify style of options with from: node/user/electron
	 * @param {string} [parseOptions.from] - where the args are from: 'node', 'user', 'electron'
	 * @return {Command} `this` command for chaining
	 */

	parse(argv: string[], parseOptions: { from?: string }): Command {
		const userArgs = this._prepareUserArgs(argv, parseOptions);
		this.#parseCommand([], userArgs);

		return this;
	}

	/**
	 * Parse `argv`, setting options and invoking commands when defined.
	 *
	 * Call with no parameters to parse `process.argv`. Detects Electron and special node options like `node --eval`. Easy mode!
	 *
	 * Or call with an array of strings to parse, and optionally where the user arguments start by specifying where the arguments are `from`:
	 * - `'node'`: default, `argv[0]` is the application and `argv[1]` is the script being run, with user arguments after that
	 * - `'electron'`: `argv[0]` is the application and `argv[1]` varies depending on whether the electron application is packaged
	 * - `'user'`: just user arguments
	 *
	 * @example
	 * await program.parseAsync(); // parse process.argv and auto-detect electron and special node flags
	 * await program.parseAsync(process.argv); // assume argv[0] is app and argv[1] is script
	 * await program.parseAsync(my-args, { from: 'user' }); // just user supplied arguments, nothing special about argv[0]
	 *
	 * @param {string[]} [argv]
	 * @param {object} [parseOptions]
	 * @param {string} parseOptions.from - where the args are from: 'node', 'user', 'electron'
	 * @return {Promise}
	 */

	async parseAsync(
		argv: string[],
		parseOptions: { from: string },
	): Promise<unknown> {
		const userArgs = this._prepareUserArgs(argv, parseOptions);
		await this.#parseCommand([], userArgs);

		return this;
	}

	/**
	 * Execute a sub-command executable.
	 */
	_executeSubCommand(subcommand: Command, args: string[]) {
		args = args.slice();
		let launchWithNode = false; // Use node for source targets so do not need to get permissions correct, and on Windows.
		const sourceExt = [".js", ".ts", ".tsx", ".mjs", ".cjs"];

		function findFile(baseDir: string, baseName: string) {
			// Look for specified file
			const localBin = path.resolve(baseDir, baseName);
			if (fs.existsSync(localBin)) return localBin;

			// Stop looking if candidate already has an expected extension.
			if (sourceExt.includes(path.extname(baseName))) return undefined;

			// Try all the extensions.
			const foundExt = sourceExt.find((ext) =>
				fs.existsSync(`${localBin}${ext}`),
			);
			if (foundExt) return `${localBin}${foundExt}`;

			return undefined;
		}

		// Not checking for help first. Unlikely to have mandatory and executable, and can't robustly test for help flags in external command.
		this.#checkForMissingMandatoryOptions();
		this.#checkForConflictingOptions();

		// executableFile and executableDir might be full path, or just a name
		let executableFile =
			subcommand._executableFile || `${this._name}-${subcommand._name}`;
		let executableDir = this.#executableDir || "";
		if (this.#scriptPath) {
			let resolvedScriptPath: string; // resolve possible symlink for installed npm binary
			try {
				resolvedScriptPath = fs.realpathSync(this.#scriptPath);
			} catch (err) {
				resolvedScriptPath = this.#scriptPath;
			}
			executableDir = path.resolve(
				path.dirname(resolvedScriptPath),
				executableDir,
			);
		}

		// Look for a local file in preference to a command in PATH.
		if (executableDir) {
			let localFile = findFile(executableDir, executableFile);

			// Legacy search using prefix of script name instead of command name
			if (!localFile && !subcommand._executableFile && this.#scriptPath) {
				const legacyName = path.basename(
					this.#scriptPath,
					path.extname(this.#scriptPath),
				);
				if (legacyName !== this._name) {
					localFile = findFile(
						executableDir,
						`${legacyName}-${subcommand._name}`,
					);
				}
			}
			executableFile = localFile || executableFile;
		}

		launchWithNode = sourceExt.includes(path.extname(executableFile));

		let proc: childProcess.ChildProcess;
		if (process.platform !== "win32") {
			if (launchWithNode) {
				args.unshift(executableFile);
				// add executable arguments to spawn
				args = incrementNodeInspectorPort(process.execArgv).concat(args);

				proc = childProcess.spawn(process.argv[0], args, { stdio: "inherit" });
			} else {
				proc = childProcess.spawn(executableFile, args, { stdio: "inherit" });
			}
		} else {
			args.unshift(executableFile);
			// add executable arguments to spawn
			args = incrementNodeInspectorPort(process.execArgv).concat(args);
			proc = childProcess.spawn(process.execPath, args, { stdio: "inherit" });
		}

		if (!proc.killed) {
			// testing mainly to avoid leak warnings during unit tests with mocked spawn
			const signals = ["SIGUSR1", "SIGUSR2", "SIGTERM", "SIGINT", "SIGHUP"];

			for (const signal of signals) {
				process.on(signal, () => {
					if (proc.killed === false && proc.exitCode === null) {
						proc.kill(signal);
					}
				});
			}
		}

		// By default terminate process when spawned process terminates.
		const exitCallback = this.#exitCallback;
		proc.on("close", (code) => {
			code = code ?? 1; // code is null if spawned process terminated due to a signal
			if (!exitCallback) {
				process.exit(code);
			} else {
				exitCallback(
					new CommanderError(
						code,
						"commander.executeSubCommandAsync",
						"(close)",
					),
				);
			}
		});
		proc.on("error", (err: Error) => {
			// @ts-ignore: because err.code is an unknown property
			if (err.code === "ENOENT") {
				const executableDirMessage = executableDir
					? `searched for local subcommand relative to directory '${executableDir}'`
					: "no directory for search for local subcommand, use .executableDir() to supply a custom directory";
				const executableMissing = `'${executableFile}' does not exist
 - if '${subcommand._name}' is not meant to be an executable command, remove description parameter from '.command()' and use '.description()' instead
 - if the default executable name is not suitable, use the executableFile option to supply a custom name or path
 - ${executableDirMessage}`;
				throw new Error(executableMissing);
				// @ts-ignore: because err.code is an unknown property
			} else if (err.code === "EACCES") {
				throw new Error(`'${executableFile}' not executable`);
			}
			if (!exitCallback) {
				process.exit(1);
			} else {
				const wrappedError = new CommanderError(
					1,
					"commander.executeSubCommandAsync",
					"(error)",
				);
				wrappedError.nestedError = err;
				exitCallback(wrappedError);
			}
		});

		// Store the reference to the child process
		this.runningCommand = proc;
	}

	#dispatchSubcommand(
		commandName: string,
		operands: string[],
		unknown: string[],
	) {
		const subCommand = this.#findCommand(commandName);
		if (!subCommand) this.help({ error: true });

		let promiseChain: Promise<unknown>;
		promiseChain = this.#chainOrCallSubCommandHook(
			promiseChain,
			subCommand,
			"preSubcommand",
		);
		promiseChain = this.#chainOrCall(promiseChain, () => {
			if (subCommand._executableHandler) {
				this._executeSubCommand(subCommand, operands.concat(unknown));
			} else {
				return subCommand.#parseCommand(operands, unknown);
			}
		});
		return promiseChain;
	}

	/**
	 * Invoke help directly if possible, or dispatch if necessary.
	 * e.g. help foo
	 */

	#dispatchHelpCommand(subcommandName: string) {
		if (!subcommandName) {
			this.help();
		}
		const subCommand = this.#findCommand(subcommandName);
		if (subCommand && !subCommand._executableHandler) {
			subCommand.help();
		}

		// Fallback to parsing the help flag to invoke the help.
		return this.#dispatchSubcommand(
			subcommandName,
			[],
			[this._getHelpOption()?.long ?? this._getHelpOption()?.short ?? "--help"],
		);
	}

	/**
	 * Check this.args against expected this.registeredArguments.
	 */
	#checkNumberOfArguments() {
		// too few
		this.registeredArguments.forEach((arg, i) => {
			if (arg.required && this.args[i] == null) {
				this.missingArgument(arg.name());
			}
		});
		// too munknown
		if (
			this.registeredArguments.length > 0 &&
			this.registeredArguments[this.registeredArguments.length - 1].variadic
		) {
			return;
		}
		if (this.args.length > this.registeredArguments.length) {
			this.#excessArguments(this.args);
		}
	}

	/**
	 * Process this.args using this.registeredArguments and save as this.processedArgs!
	 */
	#processArguments() {
		const myParseArg = (
			argument: Argument,
			value: string,
			previous: unknown,
		) => {
			// Extra processing for nice error message on parsing failure.
			let parsedValue = value;
			if (value !== null && argument.parseArg) {
				const invalidValueMessage = `error: command-argument value '${value}' is invalid for argument '${argument.name()}'.`;
				parsedValue = this.#callParseArg(
					argument,
					value,
					previous,
					invalidValueMessage,
				);
			}
			return parsedValue;
		};

		this.#checkNumberOfArguments();

		const processedArgs: unknown[] = [];
		this.registeredArguments.forEach((declaredArg, index) => {
			let value: unknown = declaredArg.defaultValue;
			if (declaredArg.variadic) {
				// Collect together remaining arguments for passing together as an array.
				if (index < this.args.length) {
					value = this.args.slice(index);
					if (declaredArg.parseArg) {
						value = (value as string[]).reduce((processed, v) => {
							return myParseArg(declaredArg, v, processed);
						}, declaredArg.defaultValue);
					}
				} else if (value === undefined) {
					value = [];
				}
			} else if (index < this.args.length) {
				value = this.args[index];
				if (declaredArg.parseArg) {
					value = myParseArg(
						declaredArg,
						value as string,
						declaredArg.defaultValue,
					);
				}
			}
			processedArgs[index] = value;
		});
		this.processedArgs = processedArgs;
	}

	#chainOrCall<T>(
		promise: Promise<T> | undefined,
		fn: () => T | undefined,
	): Promise<T> | undefined {
		// thenable
		if (promise?.then && typeof promise.then === "function") {
			// already have a promise, chain callback
			return promise.then(() => fn());
		}
		// callback might return a promise
		return fn() as undefined;
	}

	#chainOrCallHooks<T>(
		promise: Promise<T> | undefined,
		event: string,
	): Promise<T> | undefined {
		let result = promise;
		const hooks = [];

		for (const hookedCommand of this.#getCommandAndAncestors()
			.reverse()
			.filter((cmd) => cmd.#lifeCycleHooks[event] !== undefined)) {
			for (const callback of hookedCommand.#lifeCycleHooks[event]) {
				hooks.push({ hookedCommand, callback });
			}
		}

		if (event === "postAction") {
			hooks.reverse();
		}

		for (const hookDetail of hooks) {
			result = this.#chainOrCall(result, () => {
				return hookDetail.callback(hookDetail.hookedCommand, this);
			});
		}
		return result;
	}

	#chainOrCallSubCommandHook<T>(
		promise: Promise<T> | undefined,
		subCommand: Command,
		event: string,
	): Promise<T> | undefined {
		let result = promise;
		if (this.#lifeCycleHooks[event] !== undefined) {
			for (const hook of this.#lifeCycleHooks[event]) {
				result = this.#chainOrCall(result, () => {
					return hook(this, subCommand);
				});
			}
		}
		return result;
	}

	/**
	 * Process arguments in context of this command.
	 * Returns action result, in case it is a promise.
	 */
	#parseCommand(operands: string[], unknown: string[]) {
		const parsed = this.parseOptions(unknown);
		this._parseOptionsEnv(); // after cli, so parseArg not called on both cli and env
		this._parseOptionsImplied();
		operands = operands.concat(parsed.operands);
		unknown = parsed.unknown;
		this.args = operands.concat(unknown);

		if (operands && this.#findCommand(operands[0])) {
			return this.#dispatchSubcommand(operands[0], operands.slice(1), unknown);
		}
		if (
			this._getHelpCommand() &&
			operands[0] === this._getHelpCommand().name()
		) {
			return this.#dispatchHelpCommand(operands[1]);
		}
		if (this._defaultCommandName) {
			this.#outputHelpIfRequested(unknown); // Run the help for default command from parent rather than passing to default command
			return this.#dispatchSubcommand(
				this._defaultCommandName,
				operands,
				unknown,
			);
		}
		if (
			this.commands.length &&
			this.args.length === 0 &&
			!this._actionHandler &&
			!this._defaultCommandName
		) {
			// probably missing subcommand and no handler, user needs help (and exit)
			this.help({ error: true });
		}

		this.#outputHelpIfRequested(parsed.unknown);
		this.#checkForMissingMandatoryOptions();
		this.#checkForConflictingOptions();

		// We do not always call this check to avoid masking a "better" error, like unknown command.
		const checkForUnknownOptions = () => {
			if (parsed.unknown.length > 0) {
				this.unknownOption(parsed.unknown[0]);
			}
		};

		const commandEvent = `command:${this.name()}`;
		if (this._actionHandler) {
			checkForUnknownOptions();
			this.#processArguments();

			let promiseChain;
			promiseChain = this.#chainOrCallHooks(promiseChain, "preAction");
			promiseChain = this.#chainOrCall(promiseChain, () =>
				this._actionHandler(this.processedArgs),
			);
			if (this.parent) {
				promiseChain = this.#chainOrCall(promiseChain, () => {
					this.parent.emit(commandEvent, operands, unknown); // legacy
				});
			}
			promiseChain = this.#chainOrCallHooks(promiseChain, "postAction");
			return promiseChain;
		}
		if (this.parent && this.parent.listenerCount(commandEvent)) {
			checkForUnknownOptions();
			this.#processArguments();
			this.parent.emit(commandEvent, operands, unknown); // legacy
		} else if (operands.length) {
			if (this.#findCommand("*")) {
				// legacy default command
				return this.#dispatchSubcommand("*", operands, unknown);
			}
			if (this.listenerCount("command:*")) {
				// skip option check, emit event for possible misspelling suggestion
				this.emit("command:*", operands, unknown);
			} else if (this.commands.length) {
				this.unknownCommand();
			} else {
				checkForUnknownOptions();
				this.#processArguments();
			}
		} else if (this.commands.length) {
			checkForUnknownOptions();
			// This command has subcommands and nothing hooked up at this level, so display help (and exit).
			this.help({ error: true });
		} else {
			checkForUnknownOptions();
			this.#processArguments();
			// fall through for caller to handle after calling .parse()
		}
	}

	/**
	 * Find matching command.
	 */
	#findCommand(name?: string): Command | undefined {
		if (!name) return undefined;
		return this.commands.find(
			(cmd) => cmd.#name === name || cmd.#aliases.includes(name),
		);
	}

	/**
	 * Return an option matching `arg` if unknown.
	 */
	_findOption(arg: string): Option {
		return this.options.find((option) => option.is(arg));
	}

	/**
	 * Display an error message if a mandatory option does not have a value.
	 * Called after checking for help flags in leaf subcommand.
	 */
	#checkForMissingMandatoryOptions() {
		// Walk up hierarchy so can call in subcommand after checking for displaying help.

		for (const cmd of this.#getCommandAndAncestors()) {
			for (const anOption of cmd.options) {
				if (
					anOption.mandatory &&
					cmd.getOptionValue(anOption.attributeName()) === undefined
				) {
					cmd.missingMandatoryOptionValue(anOption);
				}
			}
		}
	}

	/**
	 * Display an error message if conflicting options are used together in this.
	 */
	#checkForConflictingLocalOptions() {
		const definedNonDefaultOptions = this.options.filter((option) => {
			const optionKey = option.attributeName();
			if (this.getOptionValue(optionKey) === undefined) {
				return false;
			}
			return this.getOptionValueSource(optionKey) !== "default";
		});

		const optionsWithConflicting = definedNonDefaultOptions.filter(
			(option) => option.conflictsWith.length > 0,
		);

		for (const option of optionsWithConflicting) {
			const conflictingAndDefined = definedNonDefaultOptions.find((defined) =>
				option.conflictsWith.includes(defined.attributeName()),
			);
			if (conflictingAndDefined) {
				this.#conflictingOption(option, conflictingAndDefined);
			}
		}
	}

	/**
	 * Display an error message if conflicting options are used together.
	 * Called after checking for help flags in leaf subcommand.
	 */
	#checkForConflictingOptions() {
		// Walk up hierarchy so can call in subcommand after checking for displaying help.
		for (const cmd of this.#getCommandAndAncestors()) {
			cmd.#checkForConflictingLocalOptions();
		}
	}

	/**
	 * Parse options from `argv` removing known options,
	 * and return argv split into operands and unknown arguments.
	 *
	 * Examples:
	 *
	 *     argv => operands, unknown
	 *     --known kkk op => [op], []
	 *     op --known kkk => [op], []
	 *     sub --unknown uuu op => [sub], [--unknown uuu op]
	 *     sub -- --unknown uuu op => [sub --unknown uuu op], []
	 */
	parseOptions(argv: string[]): ParseOptionsResult {
		const operands: string[] = []; // operands, not options or values
		const unknown: string[] = []; // first unknown option and remaining unknown args
		const args = argv.slice();

		let dest = operands;

		function maybeOption(arg: string) {
			return arg.length > 1 && arg[0] === "-";
		}

		// parse options
		let activeVariadicOption = null;
		while (args.length) {
			const arg = args.shift();

			// literal
			if (arg === "--") {
				if (dest === unknown) dest.push(arg);
				dest.push(...args);
				break;
			}

			if (activeVariadicOption && !maybeOption(arg)) {
				this.emit(`option:${activeVariadicOption.name()}`, arg);
				continue;
			}
			activeVariadicOption = null;

			if (maybeOption(arg)) {
				const option = this._findOption(arg);
				// recognised option, call listener to assign value with possible custom processing
				if (option) {
					if (option.required) {
						const value = args.shift();
						if (value === undefined) this.optionMissingArgument(option);
						this.emit(`option:${option.name()}`, value);
					} else if (option.optional) {
						let value = null;
						// historical behaviour is optional value is following arg unless an option
						if (args.length > 0 && !maybeOption(args[0])) {
							value = args.shift();
						}
						this.emit(`option:${option.name()}`, value);
					} else {
						// boolean flag
						this.emit(`option:${option.name()}`);
					}
					activeVariadicOption = option.variadic ? option : null;
					continue;
				}
			}

			// Look for combo options following single dash, eat first one if known.
			if (arg.length > 2 && arg[0] === "-" && arg[1] !== "-") {
				const option = this._findOption(`-${arg[1]}`);
				if (option) {
					if (
						option.required ||
						(option.optional && this._combineFlagAndOptionalValue)
					) {
						// option with value following in same argument
						this.emit(`option:${option.name()}`, arg.slice(2));
					} else {
						// boolean option, emit and put back remainder of arg for further processing
						this.emit(`option:${option.name()}`);
						args.unshift(`-${arg.slice(2)}`);
					}
					continue;
				}
			}

			// Look for known long flag with value, like --foo=bar
			if (/^--[^=]+=/.test(arg)) {
				const index = arg.indexOf("=");
				const option = this._findOption(arg.slice(0, index));
				if (option && (option.required || option.optional)) {
					this.emit(`option:${option.name()}`, arg.slice(index + 1));
					continue;
				}
			}

			// Not a recognised option by this command.
			// Might be a command-argument, or subcommand option, or unknown option, or help command or option.

			// An unknown option means further arguments also classified as unknown so can be reprocessed by subcommands.
			if (maybeOption(arg)) {
				dest = unknown;
			}

			// If using positionalOptions, stop processing our options at subcommand.
			if (
				(this._enablePositionalOptions || this._passThroughOptions) &&
				operands.length === 0 &&
				unknown.length === 0
			) {
				if (this.#findCommand(arg)) {
					operands.push(arg);
					if (args.length > 0) unknown.push(...args);
					break;
				} else if (
					this._getHelpCommand() &&
					arg === this._getHelpCommand().name()
				) {
					operands.push(arg);
					if (args.length > 0) operands.push(...args);
					break;
				} else if (this._defaultCommandName) {
					unknown.push(arg);
					if (args.length > 0) unknown.push(...args);
					break;
				}
			}

			// If using passThroughOptions, stop processing options at first command-argument.
			if (this._passThroughOptions) {
				dest.push(arg);
				if (args.length > 0) dest.push(...args);
				break;
			}

			// add arg
			dest.push(arg);
		}

		return { operands, unknown };
	}

	/**
	 * Return an object containing local option values as key-value pairs.
	 */
	opts<T extends OptionValues>(): T {
		if (this._storeOptionsAsProperties) {
			// Preserve original behaviour so backwards compatible when still using properties
			const result: OptionValues = {};
			const len = this.options.length;

			let i = 0;
			for (i; i < len; i++) {
				const key = this.options[i].attributeName();
				result[key] =
					key === this.#versionOptionName ? this.#version : this[key];
			}
			return result as T;
		}

		return this.#optionValues as T;
	}

	/**
	 * Return an object containing merged local and global option values as key-value pairs.
	 */
	optsWithGlobals<T extends OptionValues>(): T {
		// globals overwrite locals
		return this.#getCommandAndAncestors().reduce(
			(combinedOptions, cmd) => Object.assign(combinedOptions, cmd.opts()),
			{},
		) as T;
	}

	/**
	 * Display error message and exit (or call exitOverride).
	 *
	 * @param {string} message
	 * @param {object} [errorOptions]
	 * @param {string} [errorOptions.code] - an id string representing the error
	 * @param {number} [errorOptions.exitCode] - used with process.exit
	 */
	error(message: string, errorOptions: { code?: string; exitCode?: number }) {
		// output handling
		this.#outputConfiguration.outputError(
			`${message}\n`,
			this.#outputConfiguration.writeErr,
		);
		if (typeof this.#showHelpAfterError === "string") {
			this.#outputConfiguration.writeErr(`${this.#showHelpAfterError}\n`);
		} else if (this.#showHelpAfterError) {
			this.#outputConfiguration.writeErr("\n");
			this.outputHelp({ error: true });
		}

		// exit handling
		const config = errorOptions || {};
		const exitCode = config.exitCode || 1;
		const code = config.code || "commander.error";
		this.#exit(exitCode, code, message);
	}

	/**
	 * Apply unknown option related environment variables, if option does
	 * not have a value from cli or client code.
	 *
	 * @private
	 */
	_parseOptionsEnv() {
		this.options.forEach((option) => {
			if (option.envVar && option.envVar in process.env) {
				const optionKey = option.attributeName();
				// Priority check. Do not overwrite cli or options from unknown source (client-code).
				if (
					this.getOptionValue(optionKey) === undefined ||
					["default", "config", "env"].includes(
						this.getOptionValueSource(optionKey),
					)
				) {
					if (option.required || option.optional) {
						// option can take a value
						// keep very simple, optional always takes value
						this.emit(`optionEnv:${option.name()}`, process.env[option.envVar]);
					} else {
						// boolean
						// keep very simple, only care that envVar defined and not the value
						this.emit(`optionEnv:${option.name()}`);
					}
				}
			}
		});
	}

	/**
	 * Apply unknown implied option values, if option is undefined or default value.
	 *
	 * @private
	 */
	_parseOptionsImplied() {
		const dualHelper = new DualOptions(this.options);
		const hasCustomOptionValue = (optionKey) => {
			return (
				this.getOptionValue(optionKey) !== undefined &&
				!["default", "implied"].includes(this.getOptionValueSource(optionKey))
			);
		};
		this.options
			.filter(
				(option) =>
					option.implied !== undefined &&
					hasCustomOptionValue(option.attributeName()) &&
					dualHelper.valueFromOption(
						this.getOptionValue(option.attributeName()),
						option,
					),
			)
			.forEach((option) => {
				Object.keys(option.implied)
					.filter((impliedKey) => !hasCustomOptionValue(impliedKey))
					.forEach((impliedKey) => {
						this.setOptionValueWithSource(
							impliedKey,
							option.implied[impliedKey],
							"implied",
						);
					});
			});
	}

	/**
	 * Argument `name` is missing.
	 *
	 * @param {string} name
	 * @private
	 */

	missingArgument(name: string) {
		const message = `error: missing required argument '${name}'`;
		this.error(message, { code: "commander.missingArgument" });
	}

	/**
	 * `Option` is missing an argument.
	 *
	 * @param {Option} option
	 * @private
	 */

	optionMissingArgument(option: Option) {
		const message = `error: option '${option.flags}' argument missing`;
		this.error(message, { code: "commander.optionMissingArgument" });
	}

	/**
	 * `Option` does not have a value, and is a mandatory option.
	 *
	 * @param {Option} option
	 * @private
	 */

	missingMandatoryOptionValue(option: Option) {
		const message = `error: required option '${option.flags}' not specified`;
		this.error(message, { code: "commander.missingMandatoryOptionValue" });
	}

	/**
	 * `Option` conflicts with another option.
	 *
	 * @param {Option} option
	 * @param {Option} conflictingOption
	 * @private
	 */
	#conflictingOption(option: Option, conflictingOption: Option) {
		// The calling code does not know whether a negated option is the source of the
		// value, so do some work to take an educated guess.
		const findBestOptionFromValue = (option) => {
			const optionKey = option.attributeName();
			const optionValue = this.getOptionValue(optionKey);
			const negativeOption = this.options.find(
				(target) => target.negate && optionKey === target.attributeName(),
			);
			const positiveOption = this.options.find(
				(target) => !target.negate && optionKey === target.attributeName(),
			);
			if (
				negativeOption &&
				((negativeOption.presetArg === undefined && optionValue === false) ||
					(negativeOption.presetArg !== undefined &&
						optionValue === negativeOption.presetArg))
			) {
				return negativeOption;
			}
			return positiveOption || option;
		};

		const getErrorMessage = (option) => {
			const bestOption = findBestOptionFromValue(option);
			const optionKey = bestOption.attributeName();
			const source = this.getOptionValueSource(optionKey);
			if (source === "env") {
				return `environment variable '${bestOption.envVar}'`;
			}
			return `option '${bestOption.flags}'`;
		};

		const message = `error: ${getErrorMessage(option)} cannot be used with ${getErrorMessage(conflictingOption)}`;
		this.error(message, { code: "commander.conflictingOption" });
	}

	/**
	 * Unknown option `flag`.
	 *
	 * @param {string} flag
	 * @private
	 */

	unknownOption(flag: string) {
		if (this._allowUnknownOption) return;
		let suggestion = "";

		if (flag.startsWith("--") && this.#showSuggestionAfterError) {
			// Looping to pick up the global options too
			let candidateFlags = [];
			// eslint-disable-next-line @typescript-eslint/no-this-alias
			let command = this;
			do {
				const moreFlags = command
					.createHelp()
					.visibleOptions(command)
					.filter((option) => option.long)
					.map((option) => option.long);
				candidateFlags = candidateFlags.concat(moreFlags);
				command = command.parent;
			} while (command && !command._enablePositionalOptions);
			suggestion = suggestSimilar(flag, candidateFlags);
		}

		const message = `error: unknown option '${flag}'${suggestion}`;
		this.error(message, { code: "commander.unknownOption" });
	}

	/**
	 * Excess arguments, more than expected.
	 *
	 * @param {string[]} receivedArgs
	 * @private
	 */

	#excessArguments(receivedArgs: string[]) {
		if (this._allowExcessArguments) return;

		const expected = this.registeredArguments.length;
		const s = expected === 1 ? "" : "s";
		const forSubcommand = this.parent ? ` for '${this.name()}'` : "";
		const message = `error: too munknown arguments${forSubcommand}. Expected ${expected} argument${s} but got ${receivedArgs.length}.`;
		this.error(message, { code: "commander.excessArguments" });
	}

	/**
	 * Unknown command.
	 *
	 * @private
	 */

	unknownCommand() {
		const unknownName = this.args[0];
		let suggestion = "";

		if (this.#showSuggestionAfterError) {
			const candidateNames = [];
			this.createHelp()
				.visibleCommands(this)
				.forEach((command) => {
					candidateNames.push(command.name());
					// just visible alias
					if (command.alias()) candidateNames.push(command.alias());
				});
			suggestion = suggestSimilar(unknownName, candidateNames);
		}

		const message = `error: unknown command '${unknownName}'${suggestion}`;
		this.error(message, { code: "commander.unknownCommand" });
	}

	/**
	 * Get or set the program version.
	 *
	 * This method auto-registers the "-V, --version" option which will print the version number.
	 *
	 * You can optionally supply the flags and description to override the defaults.
	 *
	 * @param {string} [str]
	 * @param {string} [flags]
	 * @param {string} [description]
	 * @return {(this | string | undefined)} `this` command for chaining, or version string if no arguments
	 */

	version(
		str: string,
		flags: string,
		description: string,
	): this | string | undefined {
		if (str === undefined) return this.#version;
		this.#version = str;
		flags = flags || "-V, --version";
		description = description || "output the version number";
		const versionOption = this.createOption(flags, description);
		this.#versionOptionName = versionOption.attributeName();
		this.#registerOption(versionOption);

		this.on("option:" + versionOption.name(), () => {
			this.#outputConfiguration.writeOut(`${str}\n`);
			this.#exit(0, "commander.version", str);
		});
		return this;
	}

	/**
	 * Set the description.
	 */
	description(str?: string): Command;
	description(
		str?: string,
		argsDescription?: Record<string, string>,
	): string | Command {
		if (str === undefined && argsDescription === undefined)
			return this.#description;
		this.#description = str;
		if (argsDescription) {
			this._argsDescription = argsDescription;
		}
		return this;
	}

	/**
	 * Set the summary. Used when listed as subcommand of parent.
	 */
	summary(str?: string): Command;
	summary(): string;
	summary(str?: string): string | Command {
		if (str === undefined) return this.#summary;
		this.#summary = str;
		return this;
	}

	/**
	 * Set an alias for the command.
	 *
	 * You may call more than once to add multiple aliases. Only the first alias is shown in the auto-generated help.
	 *
	 */
	alias(alias?: string): Command;
	alias(): string;
	alias(alias?: string): string | Command {
		if (alias === undefined) return this._aliases[0]; // just return first, for backwards compatibility

		let command: Command = this;
		if (
			this.commands.length !== 0 &&
			this.commands[this.commands.length - 1]._executableHandler
		) {
			// assume adding alias for last added executable subcommand, rather than this
			command = this.commands[this.commands.length - 1];
		}

		if (alias === command._name)
			throw new Error("Command alias can't be the same as its name");
		const matchingCommand = this.parent?.#findCommand(alias);
		if (matchingCommand) {
			// c.f. _registerCommand
			const existingCmd = [matchingCommand.name()]
				.concat(matchingCommand.aliases())
				.join("|");
			throw new Error(
				`cannot add alias '${alias}' to command '${this.name()}' as already have command '${existingCmd}'`,
			);
		}

		command._aliases.push(alias);
		return this;
	}

	/**
	 * Set aliases for the command.
	 *
	 * Only the first alias is shown in the auto-generated help.
	 */
	aliases(aliases?: readonly string[]): Command;
	aliases(): string[];
	aliases(aliases?: readonly string[]): string[] | Command {
		// Getter for the array of aliases is the main reason for having aliases() in addition to alias().
		if (aliases === undefined) return this._aliases;

		for (const alias of aliases) {
			this.alias(alias);
		}
		return this;
	}

	/**
	 * Set / get the command usage `str`.
	 */
	usage(str?: string): Command;
	usage(): string;
	usage(str?: string): string | Command {
		if (str === undefined) {
			if (this.#usage) return this.#usage;

			const args = this.registeredArguments.map((arg) => {
				return humanReadableArgName(arg);
			});
			return []
				.concat(
					this.options.length || this._helpOption !== null ? "[options]" : [],
					this.commands.length ? "[command]" : [],
					this.registeredArguments.length ? args : [],
				)
				.join(" ");
		}

		this.#usage = str;
		return this;
	}

	/**
	 * Get or set the name of the command.
	 */
	name(str?: string): Command;
	name(): string;
	name(str?: string): string | Command {
		if (str === undefined) return this._name;
		this._name = str;
		return this;
	}

	/**
	 * Set the name of the command from script filename, such as process.argv[1],
	 * or require.main.filename, or __filename.
	 *
	 * (Used internally and public although not documented in README.)
	 *
	 * @example
	 * program.nameFromFilename(require.main.filename);
	 *
	 * @param {string} filename
	 * @return {Command}
	 */

	nameFromFilename(filename: string): Command {
		this._name = path.basename(filename, path.extname(filename));

		return this;
	}

	/**
	 * Get or set the directory for searching for executable subcommands of this command.
	 *
	 * @example
	 * program.executableDir(__dirname);
	 * // or
	 * program.executableDir('subcommands');
	 */
	executableDir(path: string): this;
	executableDir(): string | null;
	executableDir(path?: string): string | null | Command {
		if (path === undefined) return this.#executableDir;
		this.#executableDir = path;
		return this;
	}

	/**
	 * Return program help documentation.
	 *
	 * @param contextOptions - pass {error:true} to wrap for stderr instead of stdout
	 */

	helpInformation(contextOptions?: HelpContext): string {
		const helper = this.createHelp();
		if (helper.helpWidth === undefined) {
			helper.helpWidth = contextOptions?.error
				? this.#outputConfiguration.getErrHelpWidth()
				: this.#outputConfiguration.getOutHelpWidth();
		}
		return helper.formatHelp(this, helper);
	}

	#getHelpContext(
		contextOptions: ((str: string) => string) | HelpContext = { error: false },
	) {
		const context = { error: !!(contextOptions as HelpContext).error };
		let write: (arg: string) => boolean;
		if (context.error) {
			write = (arg) => this.#outputConfiguration.writeErr(arg);
		} else {
			write = (arg) => this.#outputConfiguration.writeOut(arg);
		}
		context.write = contextOptions.write || write;
		context.command = this;
		return context;
	}

	/**
	 * Output help information for this command.
	 *
	 * Outputs built-in help, and custom text added using `.addHelpText()`.
	 *
	 * @param contextOptions - pass {error:true} to write to stderr instead of stdout
	 */
	outputHelp(context?: HelpContext): void;
	outputHelp(cb?: (str: string) => string): void;
	outputHelp(contextOptions?: HelpContext | ((str: string) => string)) {
		let deprecatedCallback: (str: string) => string;
		if (typeof contextOptions === "function") {
			deprecatedCallback = contextOptions;
			contextOptions = undefined;
		}
		const context = this.#getHelpContext(contextOptions);

		this.#getCommandAndAncestors()
			.reverse()
			.forEach((command) => command.emit("beforeAllHelp", context));
		this.emit("beforeHelp", context);

		let helpInformation = this.helpInformation(context);
		if (deprecatedCallback) {
			helpInformation = deprecatedCallback(helpInformation);
			if (
				typeof helpInformation !== "string" &&
				!Buffer.isBuffer(helpInformation)
			) {
				throw new Error("outputHelp callback must return a string or a Buffer");
			}
		}
		context.write(helpInformation);

		if (this._getHelpOption()?.long) {
			this.emit(this._getHelpOption().long); // deprecated
		}
		this.emit("afterHelp", context);
		this.#getCommandAndAncestors().forEach((command) =>
			command.emit("afterAllHelp", context),
		);
	}

	/**
	 * You can pass in flags and a description to customise the built-in help option.
	 * Pass in false to disable the built-in help option.
	 *
	 * @example
	 * program.helpOption('-?, --help' 'show help'); // customise
	 * program.helpOption(false); // disable
	 *
	 * @param flags
	 * @param description
	 * @return `this` command for chaining
	 */

	helpOption(flags: string | boolean, description?: string): Command {
		// Support disabling built-in help option.
		if (typeof flags === "boolean") {
			if (flags) {
				this._helpOption = this._helpOption ?? undefined; // preserve existing option
			} else {
				this._helpOption = null; // disable
			}
			return this;
		}

		// Customise flags and description.
		const _flags = flags ?? "-h, --help";
		const _description = description ?? "display help for command";
		this._helpOption = this.createOption(_flags, _description);

		return this;
	}

	/**
	 * Lazy create help option.
	 * Returns null if has been disabled with .helpOption(false).
	 *
	 * @returns the help option
	 */
	_getHelpOption(): Option | null {
		// Lazy create help option on demand.
		if (this._helpOption === undefined) {
			this.helpOption(undefined, undefined);
		}
		return this._helpOption;
	}

	/**
	 * Supply your own option to use for the built-in help option.
	 * This is an alternative to using helpOption() to customise the flags and description etc.
	 *
	 * @return `this` command for chaining
	 */
	addHelpOption(option: Option): Command {
		this._helpOption = option;
		return this;
	}

	/**
	 * Output help information and exit.
	 *
	 * Outputs built-in help, and custom text added using `.addHelpText()`.
	 *
	 * @param contextOptions - pass {error:true} to write to stderr instead of stdout
	 */
	help(contextOptions?: HelpContext) {
		this.outputHelp(contextOptions);
		let exitCode = process.exitCode || 0;
		if (
			exitCode === 0 &&
			contextOptions &&
			typeof contextOptions !== "function" &&
			contextOptions.error
		) {
			exitCode = 1;
		}
		// message: do not have all displayed text available so only passing placeholder.
		this.#exit(exitCode, "commander.help", "(outputHelp)");
	}

	/**
	 * Add additional text to be displayed with the built-in help.
	 *
	 * Position is 'before' or 'after' to affect just this command,
	 * and 'beforeAll' or 'afterAll' to affect this command and all its subcommands.
	 *
	 * @param position - before or after built-in help
	 * @param text - string to add, or a function returning a string
	 * @return `this` command for chaining
	 */
	addHelpText(position: AddHelpTextPosition, text: string): this;
	addHelpText(
		position: AddHelpTextPosition,
		text: (context: AddHelpTextContext) => string,
	): this;
	addHelpText(
		position: string,
		text: string | ((context: AddHelpTextContext) => string),
	): Command {
		const allowedValues = ["beforeAll", "before", "after", "afterAll"];
		if (!allowedValues.includes(position)) {
			throw new Error(`Unexpected value for position to addHelpText.
Expecting one of '${allowedValues.join("', '")}'`);
		}
		const helpEvent = `${position}Help`;
		this.on(helpEvent, (context) => {
			let helpStr: string;

			if (typeof text === "function") {
				helpStr = text({ error: context.error, command: context.command });
			} else {
				helpStr = text;
			}
			// Ignore falsy value when nothing to output.
			if (helpStr) {
				context.write(`${helpStr}\n`);
			}
		});
		return this;
	}

	/**
	 * Output help information if help flags specified
	 *
	 * @param args - array of options to search for help flags
	 */
	#outputHelpIfRequested(args: Array<string>) {
		const helpOption = this._getHelpOption();
		const helpRequested = helpOption && args.find((arg) => helpOption.is(arg));
		if (helpRequested) {
			this.outputHelp();
			// (Do not have all displayed text available so only passing placeholder.)
			this.#exit(0, "commander.helpDisplayed", "(outputHelp)");
		}
	}
}

/**
 * Scan arguments and increment port number for inspect calls (to avoid conflicts when spawning new command).
 *
 * @param {string[]} args - array of arguments from node.execArgv
 * @returns {string[]}
 * @private
 */

function incrementNodeInspectorPort(args: string[]): string[] {
	// Testing for these options:
	//  --inspect[=[host:]port]
	//  --inspect-brk[=[host:]port]
	//  --inspect-port=[host:]port
	return args.map((arg) => {
		if (!arg.startsWith("--inspect")) {
			return arg;
		}
		let debugOption = "";
		let debugHost = "127.0.0.1";
		let debugPort = "9229";
		let match: RegExpMatchArray;
		if ((match = arg.match(/^(--inspect(-brk)?)$/)) !== null) {
			// e.g. --inspect
			debugOption = match[1];
		} else if (
			(match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+)$/)) !== null
		) {
			debugOption = match[1];
			if (/^\d+$/.test(match[3])) {
				// e.g. --inspect=1234
				debugPort = match[3];
			} else {
				// e.g. --inspect=localhost
				debugHost = match[3];
			}
		} else if (
			(match = arg.match(/^(--inspect(-brk|-port)?)=([^:]+):(\d+)$/)) !== null
		) {
			// e.g. --inspect=localhost:1234
			debugOption = match[1];
			debugHost = match[3];
			debugPort = match[4];
		}

		if (debugOption && debugPort !== "0") {
			return `${debugOption}=${debugHost}:${Number.parseInt(debugPort) + 1}`;
		}
		return arg;
	});
}

export { Command };
type TextFunction = (arg: { error: Error; command: Command }) => string;
