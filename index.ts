import { Argument } from "./lib/argument";
import { Command } from "./lib/command";
import { CommanderError, InvalidArgumentError } from "./lib/error";
import { Help } from "./lib/help";
import { Option } from "./lib/option";

const program = new Command();
const createArgument = (name: string, description?: string) =>
	new Argument(name, description);
const createOption = (flags: string, description?: string) =>
	new Option(flags, description);
const createCommand = (name?: string) => new Command(name);

export {
	program,
	//
	createArgument,
	createOption,
	createCommand,
	//
	Command,
	Option,
	Argument,
	Help,
	//
	CommanderError,
	InvalidArgumentError,
	//
	/** @deprecated */
	InvalidArgumentError as InvalidOptionArgumentError,
};
