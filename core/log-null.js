const emptyFunction = () => { };

module.exports = label => {
    return {
        monitor: emptyFunction,
        error: emptyFunction,
        fatal: emptyFunction,
        warn: emptyFunction,
        info: emptyFunction,
        debug: emptyFunction
    };
};

module.exports.setLevel = emptyFunction;
module.exports.setUpHTTP = emptyFunction;