/**
 * CommanderError class
 */
class CommanderError extends Error {
	code: string;
	exitCode: number;
	nestedError: unknown;
	/**
	 * Constructs the CommanderError class
	 * @param exitCode suggested exit code which could be used with process.exit
	 * @param code an id string representing the error
	 * @param message human-readable description of the error
	 */
	constructor(exitCode: number, code: string, message: string) {
		super(message);

		// properly capture stack trace in Node.js
		Error.captureStackTrace(this, this.constructor);
		this.name = this.constructor.name;
		this.code = code;
		this.exitCode = exitCode;
		this.nestedError = undefined;
	}
}

/**
 * InvalidArgumentError class
 */
class InvalidArgumentError extends CommanderError {
	/**
	 * Constructs the InvalidArgumentError class
	 * @param message explanation of why argument is invalid
	 */
	constructor(message?: string) {
		super(1, "commander.invalidArgument", message);

		// properly capture stack trace in Node.js
		Error.captureStackTrace(this, this.constructor);
		this.name = this.constructor.name;
	}
}

export { CommanderError, InvalidArgumentError };
