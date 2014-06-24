/*
** Module dependencies
*/
var HttpAgent = require('http').Agent;
var HttpsAgent = require('https').Agent;
var parseUrl = require('url').parse;
var Q = require('q');
var request = require('superagent');
require('superagent-retry')(request);
var _ = require('lodash');
var _s = require('underscore.string');
var libxml = require('libxmljs');
var semver = require('semver');
var debug = require('debug')('wfs');

var namespaces = require('./namespaces');

/*
** Config
*/
var Agent = {
  'http:': HttpAgent,
  'https:': HttpsAgent
};

var supportedVersions = {
    '1.0.0': {},
    '1.1.0': {},
    '2.0.0': {}
};
var supportedVersionsKeys = _.keys(supportedVersions);

/*
** Constructor
*/
function Client(url, options) {
    if (!url) throw new Error('URL is required!');
    this.url = url;
    this.options = options || {};

    if (this.options.maxSockets || this.options.keepAlive) {
        this.agent = new Agent[parseUrl(url).protocol](_.pick(this.options, 'keepAlive', 'maxSockets'));
    }
}

/*
** Private methods
*/
Client.prototype.ensureVersion = function() {
    if (this.options.version) {
        if (!(this.options.version in supportedVersions)) throw new Error('Version not supported by client');
        else return this.options.version;
    } else {
        return this.negociateVersion(supportedVersionsKeys[supportedVersionsKeys.length - 1]);
    }
};

Client.prototype.negociateVersion = function(candidateVersion) {
    var client = this;
    debug('client is trying with version %s', candidateVersion);
    return this.request({ request: 'GetCapabilities', version: candidateVersion })
        .then(function(capabilities) {
            var detectedVersion = capabilities.root().attr('version').value();
            if (!detectedVersion || !semver.valid(detectedVersion)) {
                debug('unable to read version in Capabilities');
                throw new Error('Unable to read version in Capabilities');
            }
            debug('server responded with version %s', detectedVersion);
            if (detectedVersion === candidateVersion) {
                debug('client and server versions are matching!');
                return detectedVersion;
            }
            if (semver.gt(detectedVersion, candidateVersion)) {
                debug('client candidate version (%s) is smaller than the lowest supported by server (%s)', candidateVersion, detectedVersion);
                debug('version negociation failed');
                throw new Error('Version negociation has failed. Lowest version supported by server is ' + detectedVersion + ' but candidateVersion was ' + candidateVersion);
            } else {
                debug('candidate version (%s) is greater than server one (%s)', candidateVersion, detectedVersion);
                if (detectedVersion in supportedVersions) {
                    debug('version returned by server (%s) is supported by client', detectedVersion);
                    return detectedVersion;
                }
                var nextCandidateVersion = _.findLast(supportedVersionsKeys, function(supportedVersion) {
                    return semver.lt(supportedVersion, detectedVersion);
                });
                debug('nearest smaller version supported by client is %s', nextCandidateVersion);
                return client.negociateVersion(nextCandidateVersion);
            }
        });
};

Client.prototype.request = function(query) {
    var deferred = Q.defer();

    var req = request
        .get(this.url)
        .query({ service: 'WFS' })
        .query(query);

    if (this.agent) req.agent(this.agent); // Must be called before any set method!
    if (this.options.userAgent) req.set('User-Agent', this.options.userAgent);
    if (this.options.retry) req.retry(this.options.retry);

    req.buffer()
        .end(function(err, res) {
            if (err) return deferred.reject(err);
            if (!res.text || !res.text.length) return deferred.reject(new Error('Empty body'));

            try {
                deferred.resolve(libxml.parseXml(res.text, { noblanks: true }));
            } catch(e) {
                return deferred.reject(e);
            }
        });

    return deferred.promise;
};

Client.prototype.featureTypes = function(cb) {
    this.getCapabilities(function(err, result) {
        if (err) return cb(err);

        var featureTypeNodes = result.find('/wfs:WFS_Capabilities/wfs:FeatureTypeList/wfs:FeatureType', namespaces);
        if (!featureTypeNodes) cb(null, []);
        var featureTypes = _.map(featureTypeNodes, function(featureTypeNode) {
            var featureType = {};

            function importTextValue(xpath, attributeName) {
                var node = featureTypeNode.get(xpath, namespaces);
                var value = node ? node.text() : '';
                if (value.length > 0) featureType[attributeName] = value;
            }

            importTextValue('./wfs:Name', 'name');
            importTextValue('./wfs:Title', 'title');
            importTextValue('./wfs:Abstract', 'abstract');

            // Always with WFS 2.0?
            var name;
            if (featureType.name && featureType.name.indexOf(':')) {
                name = featureType.name;
                featureType.name = _s.strRight(name, ':');
                featureType.namespace = _s.strLeft(name, ':');
            }

            return featureType;
        });

        cb(null, featureTypes);
    });
};


/*
** Exports
*/
module.exports = Client;