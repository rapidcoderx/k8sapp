# Use the official Node.js LTS image as the base image
FROM node:lts-alpine

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install dependencies
RUN npm install

# Copy the rest of the application code to the working directory
COPY . .

# Expose the port that the application listens on (3000 in this case)
EXPOSE 3000

# Start the application when the container starts
CMD ["npm", "start"]
