'use strict';

const debug = require('debug');
const chalk = require('chalk');
const _ = require('lodash');
const PassthroughEmitter = require('./passthrough-emitter');
const Promise = require('bluebird');
const pluginsLoader = require('plugins-loader');
const gracefulFs = require('graceful-fs');

const Config = require('./config');
const GeminiError = require('./errors/gemini-error');
const readTests = require('./test-reader');
const Runner = require('./runner');
const Events = require('./constants/events');
const StateProcessor = require('./state-processor');
const SuiteCollection = require('./suite-collection');
const {temp} = require('gemini-core');

const PREFIX = require('../package').name + '-';

Promise.promisifyAll(require('fs-extra'));

// patch fs module prototype for preventing EMFILE error (too many open files)
gracefulFs.gracefulify(require('fs'));

const parseBrowsers = (browsers) => {
    return browsers && browsers.replace(/\s/g, '').split(',');
};

module.exports = class Gemini extends PassthroughEmitter {
    static create(config, allowOverrides) {
        return new Gemini(config, allowOverrides);
    }

    static readRawConfig(filePath) {
        return Config.readRawConfig(filePath);
    }

    constructor(config, allowOverrides) {
        super();

        this.config = new Config(config, allowOverrides);

        this.events = Events;
        this.SuiteCollection = SuiteCollection;

        setupLog(this.config.system.debug);
        this._loadPlugins();
    }

    extendCli(parser) {
        this.emit(Events.CLI, parser);
    }

    getScreenshotPath(suite, stateName, browserId) {
        return this.config.forBrowser(browserId).getScreenshotPath(suite, stateName);
    }

    getBrowserCapabilites(browserId) {
        return this.config.forBrowser(browserId).desiredCapabilities;
    }

    getValidBrowsers(browsers) {
        return _.intersection(browsers, this.browserIds);
    }

    checkUnknownBrowsers(browsers) {
        const browsersFromConfig = this.browserIds;
        const unknownBrowsers = _.difference(browsers, browsersFromConfig);

        if (unknownBrowsers.length) {
            console.warn(
                `${chalk.yellow('WARNING:')} Unknown browsers id: ${unknownBrowsers.join(', ')}.\n` +
                `Use one of the browser ids specified in config file: ${browsersFromConfig.join(', ')}`
            );
        }
    }

    get browserIds() {
        return this.config.getBrowserIds();
    }

    update(paths, options) {
        return this._exec(() => this._run(StateProcessor.createScreenUpdater(this.config, options), paths, options));
    }

    test(paths, options) {
        return this._exec(() => this._run(StateProcessor.createTester(this.config), paths, options));
    }

    readTests(paths, options = {}) {
        return this._exec(() => this._readTests(paths, options));
    }

    halt(err, timeout = 60000) {
        this._runner.cancel();

        this._criticalError = new GeminiError(err);

        if (timeout === 0) {
            return;
        }

        setTimeout(() => {
            console.error(chalk.red('Forcing shutdown...'));
            process.exit(1);
        }, timeout).unref();
    }

    _exec(fn) {
        return this._init()
            .then(() => fn())
            .finally(() => {
                if (this._criticalError) {
                    throw this._criticalError;
                }
            });
    }

    _init() {
        this._init = () => Promise.resolve(); // init only once
        return this.emitAndWait(Events.INIT);
    }

    _loadPlugins() {
        pluginsLoader.load(this, this.config.system.plugins, PREFIX);
    }

    _readTests(paths, options) {
        options = _.assignIn(options, {paths});

        return readTests(this, this.config, options)
            .then((rootSuite) => {
                if (options.grep) {
                    applyGrep_(options.grep, rootSuite);
                }

                const suiteCollection = new SuiteCollection(rootSuite.children);
                this.emit(Events.AFTER_TESTS_READ, {suiteCollection});
                return suiteCollection;
            });

        function applyGrep_(grep, suite) {
            if (!suite.hasStates) {
                _.clone(suite.children).forEach((child) => {
                    applyGrep_(grep, child, suite);
                });
            } else {
                if (!grep.test(suite.fullName)) {
                    suite.parent.removeChild(suite);
                }
            }

            if (!suite.hasStates && !suite.children.length && suite.parent) {
                suite.parent.removeChild(suite);
            }
        }
    }

    _run(stateProcessor, paths, options) {
        if (!options) {
            //if there are only two arguments, they are
            //(stateProcessor, options) and paths are
            //the default.
            options = paths;
            paths = undefined;
        }
        options = options || {};
        options.reporters = options.reporters || [];

        temp.init(this.config.system.tempDir);

        const runner = this._runner = Runner.create(this.config, stateProcessor);
        const envBrowsers = parseBrowsers(process.env.GEMINI_BROWSERS);
        const envSkipBrowsers = parseBrowsers(process.env.GEMINI_SKIP_BROWSERS);

        options.browsers = options.browsers || envBrowsers;

        this._passThroughEvents(runner);

        // it is important to require signal handler here in order to guarantee subscribing to "INTERRUPT" event
        require('./signal-handler').on(Events.INTERRUPT, (data) => {
            this.emit(Events.INTERRUPT, data);

            runner.cancel();
        });

        if (options.browsers) {
            this.checkUnknownBrowsers(options.browsers);
        }

        const getTests = (source, options) => {
            return source instanceof SuiteCollection
                ? Promise.resolve(source)
                : this._readTests(source, options);
        };

        return getTests(paths, options)
            .then((suiteCollection) => {
                this.checkUnknownBrowsers(envSkipBrowsers);

                const validSkippedBrowsers = this.getValidBrowsers(envSkipBrowsers);

                suiteCollection.skipBrowsers(validSkippedBrowsers);
                options.reporters.forEach((reporter) => applyReporter(runner, reporter));

                let testsStatistic;
                runner.on(Events.END, (stats) => testsStatistic = stats);

                return runner.run(suiteCollection)
                    .then(() => testsStatistic);
            });
    }

    _passThroughEvents(runner) {
        this.passthroughEvent(runner, _.values(Events));
    }
};

function applyReporter(runner, reporter) {
    if (typeof reporter === 'string') {
        reporter = {name: reporter};
    }
    if (typeof reporter === 'object') {
        const reporterPath = reporter.path;
        try {
            reporter = require('./reporters/' + reporter.name);
        } catch (e) {
            if (e.code === 'MODULE_NOT_FOUND') {
                throw new GeminiError('No such reporter: ' + reporter.name);
            }
            throw e;
        }

        return reporter(runner, reporterPath);
    }
    if (typeof reporter !== 'function') {
        throw new TypeError('Reporter must be a string, an object or a function');
    }

    reporter(runner);
}

function setupLog(isDebug) {
    if (isDebug) {
        Promise.config({
            longStackTraces: true
        });
        debug.enable('gemini:*');
    }
}
