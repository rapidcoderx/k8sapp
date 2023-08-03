const express = require('express');
const basicAuth = require('express-basic-auth');

const app = express();
const port = 3000;

const {rolloutRestartDeployment, getPodInfo, updatePodStatusMetric, getNamespaces, getDeploymentNames, getEvents} = require('./kubernetesUtils');

// Middleware for HTTP Basic Authentication
const basicAuthMiddleware = basicAuth({
    users: { [process.env.BASIC_AUTH_USERNAME]: process.env.BASIC_AUTH_PASSWORD },
    challenge: true,
    unauthorizedResponse: (req) => {
        return req.auth
            ? 'Authentication failed'
            : 'No credentials provided';
    },
});

// Expose the Prometheus metrics endpoint
app.get('/metrics', async (req, res) => {
    await updatePodStatusMetric();
    res.set('Content-Type', 'text/plain');
    const metrics = await registry.metrics();
    res.send(metrics);
});

/**
 * @param request          Incoming request.
 * @param request.query.labelname   Label to be used for searching pod.
 * @param request.query.deployment  Deployment name to search for.
 * @param request.query.namespace   Namespace to search for.
 * @param response         Response to be sent back.
 * @return {Promise<void>}
 */

// Expose the pod info endpoint as JSON
app.get('/api/podInfo', async (req, res) => {
    const namespace = req.query.namespace || 'default';
    const deployment = req.query.deployment || 'skooner';
    const labelname = req.query.labelname || 'k8s-app';

    if (!deployment) {
        return res.status(400).json({error: 'Deployment name query parameter is missing.'});
    }

    const podInfo = await getPodInfo(namespace, deployment, labelname);

    if (!podInfo || podInfo.length === 0) {
        return res.status(404).json({error: 'No pods found for the provided deployment.'});
    }

    res.json(podInfo);
});

// Patch route to perform rollout restart of a deployment
app.patch('/api/rollout-restart/:namespace?/:deploymentName?', basicAuthMiddleware, async (req, res) => {
    const {namespace, deploymentName} = req.params;
    const defaultNamespace = 'default'; // Provide your default namespace here
    const defaultDeploymentName = 'skooner'; // Provide your default deployment name here

    try {
        const targetNamespace = namespace ?? defaultNamespace;
        const targetDeploymentName = deploymentName ?? defaultDeploymentName;

        await rolloutRestartDeployment(targetNamespace, targetDeploymentName);
        return res.status(200).json({ status: 'success', message: 'Rollout restart successful.' });
    } catch (err) {
        console.error('Error during rollout restart:', err);
        return res.status(500).json({error: 'An error occurred during rollout restart.'});
    }
});

// Endpoint to get a list of namespaces
app.get('/api/namespaces', async (req, res) => {
    try {
        const namespaces = await getNamespaces();
        res.json(namespaces);
    } catch (err) {
        console.error('Error getting namespaces:', err);
        res.status(500).json({ error: 'An error occurred while fetching namespaces.' });
    }
});

// Endpoint to get deployment names for a given namespace
app.get('/api/deployments/:namespace', async (req, res) => {
    const namespace = req.params.namespace;

    if (!namespace) {
        return res.status(400).json({ error: 'Namespace is required.' });
    }

    try {
        const deploymentNames = await getDeploymentNames(namespace);
        return res.json(deploymentNames);
    } catch (err) {
        console.error('Error fetching deployment names:', err);
        return res.status(500).json({ error: 'An error occurred while fetching deployment names.' });
    }
});

// Endpoint to get events for a given namespace and deployment name
app.get('/api/events/:namespace/:deploymentName', async (req, res) => {
    const namespace = req.params.namespace;
    const deploymentName = req.params.deploymentName;

    if (!namespace || !deploymentName) {
        return res.status(400).json({ error: 'Namespace and deploymentName are required.' });
    }

    try {
        const events = await getEvents(namespace, deploymentName);
        return res.json(events);
    } catch (err) {
        console.error('Error fetching events:', err);
        return res.status(500).json({ error: 'An error occurred while fetching events.' });
    }
});

// Endpoint to serve the index.html file
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// Serve static files from the 'public' directory
app.use(express.static('public'));

// Start the Express server
app.listen(port, () => {
    console.log(`Server is running`);
});

// Scraping interval as environment variable with default value 5000 (5 seconds)
const scrapingInterval = parseInt(process.env.SCRAPING_INTERVAL) || 5000;
setInterval(updatePodStatusMetric, scrapingInterval);
