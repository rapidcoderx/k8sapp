const axios = require('axios');
const https = require('https');
const fs = require('fs');
const {Registry, Gauge} = require('prom-client');
const basicAuth = require('express-basic-auth');

// Create a Prometheus registry to manage custom metrics.
const registry = new Registry();

// Create a Prometheus Gauge metric to represent the pod status
const podStatusGauge = new Gauge({
    name: 'kube_pod_status',
    help: 'Kubernetes Pod Status (0: Pending, 1: Running, 2: Succeeded, 3: Failed, 4: Unknown)',
    labelNames: ['namespace', 'deployment', 'pod_name'],
    registers: [registry],
});

async function updatePodStatusMetric() {
    const axiosInstance = createAxiosInstance();
    const namespace = 'default';
    const kubeToken = getServiceAccountToken();

    if (!kubeToken) {
        console.error('Kubernetes token not provided or could not be read from service account.');
        return;
    }

    try {
        const response = await axiosInstance.get(`https://kubernetes.default/api/v1/namespaces/${namespace}/pods`, {
            headers: {
                Authorization: `Bearer ${kubeToken}`,
            },
        });

        const pods = response.data.items;

        pods.forEach((pod) => {
            const podStatus = getPodStatusValue(pod.status.phase);
            const deploymentName = pod.metadata.labels?.app ?? 'Unknown';
            podStatusGauge.labels(namespace, deploymentName, pod.metadata.name).set(podStatus);
        });
    } catch (err) {
        console.error('Error querying the Kubernetes API:', err);
    }
}

// Helper function to map pod status to numeric values
function getPodStatusValue(status) {
    switch (status) {
        case 'Pending':
            return 0;
        case 'Running':
            return 1;
        case 'Succeeded':
            return 2;
        case 'Failed':
            return 3;
        default:
            return 4; // Unknown
    }
}

// Function to convert memory usage from KiB to MB and add the "MB" suffix
function convertToMB(memoryUsageKi, addSuffix = true) {
    if (!memoryUsageKi) return "N/A";
    const memoryUsageBytes = parseInt(memoryUsageKi) * 1024;
    const memoryUsageMB = memoryUsageBytes / (1024 * 1024);
    return addSuffix ? memoryUsageMB.toFixed(2) + "Mi" : memoryUsageMB.toFixed(2);
}

// Function to convert CPU usage from nano cores to milli cores and add the "m" suffix
function convertToMilliCores(cpuUsageNanoCores, addSuffix = true) {
    if (!cpuUsageNanoCores) return "N/A";
    const cpuUsageMilliCores = (cpuUsageNanoCores * 1000000) / 1000000;
    return addSuffix ? cpuUsageMilliCores.toFixed(2) + "m" : cpuUsageMilliCores.toFixed(2);
}

async function getPodInfo(namespace, deployment, labelName) {
    const kubeToken = getServiceAccountToken();

    if (!kubeToken) {
        console.error('Kubernetes token not provided or available from the service account.');
        return null;
    }

    try {
        const pods = await getPods(namespace, kubeToken);
        const podInfoList = [];

        for (const pod of pods) {
            const podDeployment = getPodDeployment(pod, labelName);

            if (podDeployment === deployment) {
                const {cpuUsageNanoCoresTotal, memoryUsageKiTotal} = await getPodMetrics(pod, namespace, kubeToken);
                const cpuLimitNanoCores = getCPULimitNanoCores(pod);

                const cpuUsagePercentage = calculateCPUUsagePercentage(cpuUsageNanoCoresTotal, cpuLimitNanoCores);
                const memoryRequestKi = getMemoryRequestKi(pod);
                const memoryLimitKi = getMemoryLimitKi(pod);

                const podInfo = {
                    name: pod.metadata.name,
                    namespace: namespace,
                    deployment: podDeployment,
                    status: pod.status?.phase ?? 'Unknown', // Access the status using pod.status.phase
                    containers: pod.spec?.containers.map((container) => container.name) || [],
                    memoryRequest: convertToMB(memoryRequestKi), // Memory request with the "MB" suffix or "N/A" if not present
                    memoryLimit: convertToMB(memoryLimitKi), // Memory limit with the "MB" suffix or "N/A" if not present
                    memoryUsage: convertToMB(memoryUsageKiTotal), // Memory usage with the "MB" suffix
                    cpuUsagePercentage: cpuUsagePercentage === "N/A" ? "N/A" : `${cpuUsagePercentage}%`, // Add the "%" suffix to the CPU usage value
                    cpuUsageMilliCores: convertToMilliCores(cpuUsageNanoCoresTotal), // CPU usage in milli cores with the "m" suffix or "N/A" if not present
                };

                podInfoList.push(podInfo);
            }
        }

        return podInfoList;
    } catch (err) {
        console.error('Error querying the Kubernetes API:', err);
        return null;
    }
}

// Helper function to fetch pods from the Kubernetes API
async function getPods(namespace, kubeToken) {
    const axiosInstance = createAxiosInstance();
    const response = await axiosInstance.get(`https://kubernetes.default/api/v1/namespaces/${namespace}/pods`, {
        headers: {
            Authorization: `Bearer ${kubeToken}`,
        },
    });
    return response.data.items;
}

// Helper function to get the pod deployment from labels
function getPodDeployment(pod, labelName) {
    return pod.metadata?.labels?.[labelName] ?? 'Unknown';
}

// Helper function to fetch pod metrics from the Kubernetes API
async function getPodMetrics(pod, namespace, kubeToken) {
    const axiosInstance = createAxiosInstance();
    const podMetricsResponse = await axiosInstance.get(`https://kubernetes.default/apis/metrics.k8s.io/v1beta1/namespaces/${namespace}/pods/${pod.metadata.name}`, {
        headers: {
            Authorization: `Bearer ${kubeToken}`,
        },
    });

    const containers = podMetricsResponse?.data?.containers || [];
    let cpuUsageNanoCoresTotal = 0;
    let memoryUsageKiTotal = 0;

    for (const container of containers) {
        const cpuUsageNanoCores = container.usage.cpu || "0";
        const memoryUsageKi = container.usage.memory || "0";
        cpuUsageNanoCoresTotal += parseNanoCores(cpuUsageNanoCores);
        memoryUsageKiTotal += parseInt(memoryUsageKi);
    }

    return {cpuUsageNanoCoresTotal, memoryUsageKiTotal};
}

// Helper function to get CPU limit in nano cores from pod spec
function getCPULimitNanoCores(pod) {
    return pod.spec?.containers.reduce((acc, container) => acc + parseNanoCores(container.resources?.limits?.cpu || "0"), 0);
}

// Helper function to calculate CPU usage percentage
function calculateCPUUsagePercentage(cpuUsageNanoCoresTotal, cpuLimitNanoCores) {
    if (cpuLimitNanoCores > 0) {
        return ((cpuUsageNanoCoresTotal / cpuLimitNanoCores) * 100).toFixed(2);
    }
    return "N/A";
}

// Helper function to get memory request in Ki (Kibibytes) from pod spec
function getMemoryRequestKi(pod) {
    return pod.spec?.containers.reduce((acc, container) => acc + container.resources?.requests?.memory || "0", 0);
}

// Helper function to get memory limit in Ki (Kibibytes) from pod spec
function getMemoryLimitKi(pod) {
    return pod.spec?.containers.reduce((acc, container) => acc + container.resources?.limits?.memory || "0", 0);
}

// Function to parse CPU cores from nano cores format to an integer value
function parseNanoCores(cpuValue) {
    const regex = /(\d+)(n?)/;
    const match = cpuValue.match(regex);
    if (match) {
        const value = parseInt(match[1]);
        const suffix = match[2];
        if (suffix === 'n') {
            return value / 1000000; // Convert nano cores to milli cores (1 n = 0.000001 m)
        }
        return value;
    }
    return 0;
}

// Function to create an axios instance with certificate verification disabled
function createAxiosInstance() {
    return axios.create({
        httpsAgent: new https.Agent({
            rejectUnauthorized: false, // Ignore certificate errors
        }),
    });
}

// Function to get the service account token from inside the pod
function getServiceAccountToken() {
    try {
        return fs.readFileSync('/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8');
    } catch (err) {
        console.error('Error reading the service account token:', err);
        return null;
    }
}

// Function to perform a patch request on a deployment in Kubernetes
async function patchDeployment(namespace, deploymentName, patchData) {
    const axiosInstance = createAxiosInstance();
    const kubeToken = getServiceAccountToken();

    try {
        const response = await axiosInstance.patch(`https://kubernetes.default/apis/apps/v1/namespaces/${namespace}/deployments/${deploymentName}`, patchData, {
            headers: {
                Authorization: `Bearer ${kubeToken}`, 'Content-Type': 'application/strategic-merge-patch+json',
            },
        });

        console.log(`Rollout restart of deployment ${deploymentName} in namespace ${namespace} is initiated.`);
        return response.data;
    } catch (err) {
        console.error('Error performing the patch:', err);
        return null;
    }
}

// Function to perform a rollout restart of a deployment in Kubernetes
async function rolloutRestartDeployment(namespace, deploymentName) {
    const currentTimestamp = new Date().toISOString();
    const patchData = {
        spec: {
            template: {
                metadata: {
                    annotations: {
                        'kubectl.kubernetes.io/restartedAt': currentTimestamp,
                    },
                },
            },
        },
    };

    return patchDeployment(namespace, deploymentName, patchData);
}

// Function to get a list of namespaces
async function getNamespaces() {
    const axiosInstance = createAxiosInstance();
    const kubeToken = getServiceAccountToken();

    if (!kubeToken) {
        console.error('Kubernetes token not provided or available from the service account.');
        return [];
    }

    try {
        const response = await axiosInstance.get('https://kubernetes.default/api/v1/namespaces', {
            headers: {
                Authorization: `Bearer ${kubeToken}`,
            },
        });
        const namespaces = response.data.items;

        // Read skip namespaces from environment variable
        const skipNamespacesEnv = process.env.SKIP_NAMESPACES || '';
        const skipNamespaces = skipNamespacesEnv.split(',').map((ns) => ns.trim());

        // Filter out namespaces based on skip criteria
        const filteredNamespaces = namespaces.filter((ns) => !skipNamespaces.includes(ns.metadata.name));

        return filteredNamespaces.map((ns) => ns.metadata.name);
    } catch (err) {
        console.error('Error querying the Kubernetes API:', err);
        return [];
    }
}

// Function to get deployment names for a given namespace
async function getDeploymentNames(namespace) {
    const axiosInstance = createAxiosInstance();
    const kubeToken = getServiceAccountToken();

    if (!kubeToken) {
        console.error('Kubernetes token not provided or available from the service account.');
        return [];
    }
    try {
        const response = await axiosInstance.get(`https://kubernetes.default/apis/apps/v1/namespaces/${namespace}/deployments`, {
            headers: {
                Authorization: `Bearer ${kubeToken}`,
            },
        });

        const deployments = response.data.items;
        return deployments.map((deployment) => deployment.metadata.name);
    } catch (err) {
        console.error('Error querying the Kubernetes API:', err);
        return [];
    }
}

// Function to get events for a given namespace and deployment name
async function getEvents(namespace, deploymentName) {
    const axiosInstance = createAxiosInstance();
    const kubeToken = getServiceAccountToken();

    if (!kubeToken) {
        console.error('Kubernetes token not provided or available from the service account.');
        return [];
    }

    try {
        const response = await axiosInstance.get(`https://kubernetes.default/api/v1/namespaces/${namespace}/events?fieldSelector=involvedObject.name=${deploymentName}`, {
            headers: {
                Authorization: `Bearer ${kubeToken}`,
            },
        });

        const events = response.data.items;
        return events.map((event) => {
            return {
                reason: event.reason,
                message: event.message,
                type: event.type,
                count: event.count,
                lastTimestamp: event.lastTimestamp,
            };
        });
    } catch (err) {
        console.error('Error querying the Kubernetes API:', err);
        return [];
    }
}

module.exports = {
    getPodInfo, updatePodStatusMetric, rolloutRestartDeployment, getNamespaces, getDeploymentNames, getEvents,
};

