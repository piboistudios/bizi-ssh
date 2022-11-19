FROM node:16.17.0
RUN apt-get update
RUN apt-get -y install openssh-server
RUN apt-get -y install net-tools
RUN apt-get -y install lsof
RUN apt-get -y install iproute2
RUN apt-get -y install ldap-utils
COPY . app
WORKDIR /app
RUN npm install
CMD ["npm","start"]

EXPOSE 22