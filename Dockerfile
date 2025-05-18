    # Use an official Node.js runtime as a parent image
    # We'll use Node.js 18-slim, which is a good balance of features and size.
    # You can adjust this (e.g., to node:20-slim) if your project specifically needs a newer version.
    FROM node:18-slim

    # Set the working directory inside the container
    # This is where your app's files will live and commands will be run from
    WORKDIR /usr/src/app

    # Copy package.json and package-lock.json (or yarn.lock if you use Yarn)
    # These are copied first to leverage Docker's layer caching.
    # If these files haven't changed, Docker can reuse the cached layer from a previous build
    # where dependencies were installed, speeding up subsequent builds.
    COPY package*.json ./

    # Install app dependencies
    # --omit=dev: Skips installing development dependencies (like nodemon, eslint, etc.)
    # --only=production: (Alternative to --omit=dev) Installs only production dependencies.
    # For a typical discord.js bot, --omit=dev is usually sufficient.
    # If you have native C++ addons that need compiling, you might need to install 'build-essential' or 'python' first:
    # RUN apt-get update && apt-get install -y build-essential python gcc g++ make && rm -rf /var/lib/apt/lists/*
    RUN npm install --omit=dev

    # Bundle app source code into the Docker image
    # This copies everything from your project's root directory (where the Dockerfile is)
    # into the /usr/src/app directory inside the container.
    # Ensure your .dockerignore file (similar to .gitignore) excludes node_modules, .git, etc.
    # if they are not already excluded by your build context.
    # For Fly.io, it usually builds from your local directory context, respecting .dockerignore or .gitignore.
    COPY . .

    # Define the command to run your application when the container starts
    # This will execute 'node index.js'
    CMD [ "node", "index.js" ]
    
