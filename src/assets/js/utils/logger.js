/**
 * @author Luuxis
 * Luuxis License v1.0 (voir fichier LICENSE pour les détails en FR/EN)
 */

let console_log = console.log;
let console_info = console.info;
let console_warn = console.warn;
let console_debug = console.debug;
let console_error = console.error;

class logger {
    constructor(name, color) {
        this.name = name;
        this.color = color;
        this.Logger(name, color)
    }

    async Logger(name, color) {
        console.log = value => {
            console_log.call(console, `%c[${name}]:`, `color: ${color};`, value);
        };

        console.info = value => {
            console_info.call(console, `%c[${name}]:`, `color: ${color};`, value);
        };

        console.warn = value => {
            console_warn.call(console, `%c[${name}]:`, `color: ${color};`, value);
        };

        console.debug = value => {
            console_debug.call(console, `%c[${name}]:`, `color: ${color};`, value);
        };

        console.error = value => {
            console_error.call(console, `%c[${name}]:`, `color: ${color};`, value);
        };
    }

    log(value) {
        console_log.call(console, `%c[${this.name}]:`, `color: ${this.color};`, value);
    }

    info(value) {
        console_info.call(console, `%c[${this.name}]:`, `color: ${this.color};`, value);
    }

    warn(value) {
        console_warn.call(console, `%c[${this.name}]:`, `color: ${this.color};`, value);
    }

    error(value) {
        console_error.call(console, `%c[${this.name}]:`, `color: ${this.color};`, value);
    }

    debug(value) {
        console_debug.call(console, `%c[${this.name}]:`, `color: ${this.color};`, value);
    }
}

export default logger;