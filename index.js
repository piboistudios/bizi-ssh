require('dotenv').config();
const fs = require('fs');
const serverName = process.env.SERVER_NAME || 'bizi-ssh';
const sshdDir = process.env.SSHD_DIR || 'ssh';
const { mkLogger } = require('./logger');
const { promisify } = require('bluebird');
const mime = require('mime-types');
const util = require('util');
const async = require('async');
const { exec, spawn } = require('child_process');
/**@type {function(string): Promise<string[]> */
const execAsync = promisify(exec, { multiArgs: true });
const chmod = require('chmod');
const useraddSync = require('useradd');
/**@typedef {import('mongodb').GridFSBucket & import('mongoose').Model<import('mongodb').GridFSFile, {}, {read:function():import('stream').Readable}, {}> & {write:function(import('mongodb').GridFSFile, import('stream').Readable):ThisType}} FileSchema */

/** @type FileSchema */
let ConfigFile;
/** @type FileSchema */
let KeyFile;
/** @type FileSchema */
let File;

/**
 * @type {function({
 *  gid: number,
 *  login: string,
 *  home: string,
 *  shell: string
 * } | string) => Promise<any>}
 * 
 */
const useradd = promisify(useraddSync);
const chown = require('chown');

const mongoose = require('mongoose');


const { join, isAbsolute } = require('path');
const { PassThrough, Transform } = require('stream');
const { EOL } = require('os');
var logger = mkLogger('top');
const dbhost = process.env.DB_ADDR || "127.0.0.1",
    dbport = process.env.DB_PORT || 27017,
    dbname = new String(process.env.DB_NAME || "/feta/db").replace(/\//g, ""),
    dbuser = encodeURIComponent(process.env.DB_USER),
    dbpass = encodeURIComponent(process.env.DB_PASS);
const dsn = util.format("mongodb://%s:%s@%s:%s/%s", dbuser, dbpass, dbhost, dbport, dbname);
const options = {
    auth: {
        user: dbuser,
        pass: dbpass
    }
};




/**
 * 
 * @param {string} path 
 * @param {import('mongodb').GridFSBucket & {
 *  write: function(import('mongoose').Document<any>, import('stream').Readable): import('mongoose').Document<any>
 * }} model 
 * @param {(string) => any} metadataFn 
 * @returns 
 */
async function ensureFiles(path, model, metadataFn) {
    logger.info("Ensuring", { path, model, meta: metadataFn('foo') });
    const filenames = fs.readdirSync(path);
    const existingFileRecordsResult = await model.find({ filename: { $in: filenames } });
    logger.debug({ existingFileRecordsResult });
    const existingFileRecords = existingFileRecordsResult;
    const missingFiles = filenames
        .filter(
            f => !existingFileRecords
                .some(
                    ef => ef.filename.toLowerCase() === f.toLowerCase()
                )
        );
    if (missingFiles.length) {

        let write = promisify(model.write, { context: model });


        const missingFileFns = missingFiles.map(f => async.reflect(async.asyncify(() => {
            logger.info("Missing file:", f);
            const rs = fs.createReadStream(join(path, f));
            return write({
                filename: f,
                contentType: mime.lookup(f),
                metadata: metadataFn(f)
            }, rs);
        })));
        logger.debug("Missing File Fns:", missingFileFns);
        const createdFileResults = await async.series(missingFileFns);

        createdFileResults.forEach(r => {
            if (r.error) {
                logger.warn('Unable to upload file:', r.error);
            } else {
                existingFileRecords.push(r.value);
            }
        });
    }
    return existingFileRecords;
}
/**
 * 
 * @param {(import('mongodb').GridFSFile & {
 * read: function(): import('stream').Readable})[]} gridFiles 
 * @param {string} path 
 */
function downloadFiles(gridFiles, path) {
    return Promise.all(gridFiles.map(f => {
        const rs = f.read();
        const ws = fs.createWriteStream(join(path, f.filename));
        return new Promise((resolve, reject) => rs.pipe(ws)
            .on('finish', resolve)
            .on('error', reject)
        );
    }));
}

async function addUser(user) {
    const username = user.uid;
    logger.info("Adding user", username);
    try {

        await useradd({
            login: username,
            home: `/home/${username}`,
            shell: false
        });
    } catch (e) {
        logger.error("Unable to add user ERROR:", e);
    }
    let uid, gid;
    try {
        const [stdout, stderr] = await execAsync(`id -u ${username}`);
        uid = Number(stdout.trim());
    } catch (e) {
        logger.error("Unable to retrieve uid:", e);
    }
    try {
        const [stdout, stderr] = await execAsync(`id -g ${username}`);
        gid = Number(stdout.trim())
    } catch (e) {
        logger.error("Unable to retrieve gid:", e);
    }
    const ret = { uid, gid };
    logger.debug("addUser result:", ret);
    if (uid) user.uidnumber = uid;
    if (gid) user.gidnumber = gid;
    logger.info("Upodating user uid and gid in database..");
    try {

        await user.save();
        logger.info("User saved.");
    } catch (e) {
        logger.error("Unable to update user uid and gid:", e);
    }
    return ret;
}

async function grabOrGenerateKey(keyType) {
    const filename = `ssh_host_${keyType}_key`
    logger.info("Fetching", filename);
    try {

        var existing = await KeyFile.findOne({ filename });

    } catch (e) {
        logger.error("Unable to retrieve host key file " + keyType + ":", e);
    }

    if (!existing) {
        logger.info(filename, "not found in database, generating...");
        const cmd = `ssh-keygen -q -N "" -t ${keyType} -f  ${sshdDir + '/' + filename}`;
        logger.info("Running", cmd);
        const [stdout, stderr] = await execAsync(cmd);
        logger.debug("SSH Keygen stdout:", stdout);
        logger.warn("SSH Keygen stderr:", stderr);
        return Promise.all([filename, /* filename + '.pub' */].map(filename => KeyFile.write({
            filename,
            contentType: 'text/plain',
            metadata: {
                app: 'bizi-openssh'
            }
        }, fs.createReadStream(join(sshdDir, filename)))))
            .then(() => {
                logger.info("Hostkeys sycned.");
            })
            .catch(e => {
                logger.error(`Unable to write keyfiles for ${filename} ERROR:`, e);
                throw e;
            });
    } else {
        logger.info(filename, "found.");
        const rs = existing.read();
        const ws = fs.createWriteStream(join(sshdDir, filename));
        return new Promise((resolve, reject) =>
            rs.pipe(ws)
                .on('finish', resolve)
                .on('error', reject)
        )
            .then(() => {
                logger.info("Hostkeys restored.");
            })
            .catch(e => {
                logger.error(`Unable to restore keyfiles for ${filename} ERROR:`, e);
                throw e;
            });
    }

}
logger.info("Mongo DSN:", dsn);
logger.info("Mongo options:", options);
mongoose.connect(dsn)
    .then(async cnx => {
        ConfigFile = require('./models/ConfigFile');
        KeyFile = require('./models/KeyFile');
        File = require('./models/File');
        const User = require('./models/User');

        logger.info("Retrieving hostkeys...");
        const hostKeyAlgos = ['dsa', 'rsa', 'ecdsa', 'ed25519'];
        await Promise.all(hostKeyAlgos.map(grabOrGenerateKey));

        logger.info("Retrieving users...");
        const users = User.find();
        const cursor = users.cursor();
        logger.info("Adding them to system...");
        await cursor.eachAsync(u => addUser(u))
        await cursor.close();
        logger.info("Closing user cursor...");
        logger.info("Starting ssh service...");
        const { timingSafeEqual } = require('crypto')
        function checkValue(input, allowed) {
            const autoReject = (input.length !== allowed.length);
            if (autoReject) {
                // Prevent leaking length information by always making a comparison with the
                // same input when lengths don't match what we expect ...
                allowed = input;
            }
            const isMatch = timingSafeEqual(input, allowed);
            return (!autoReject && isMatch);
        }
        const ssh2 = require('ssh2');
        logger.info("Creating service...");
        const server = new ssh2.Server({
            hostKeys: hostKeyAlgos.map(algo => fs.readFileSync(join(sshdDir, `ssh_host_${algo}_key`))),
            greeting: "What's good in the hood",
        }, client => {
            /**@type {import('mongoose').Document<import('./models/User')>} */
            let user;
            client
                .on('authentication', async ctx => {
                    var logger = mkLogger(`authn:${ctx.username}:${ctx.localHostname}:${ctx.localUsername}`);
                    logger.info("Starting authentication for method..", ctx.method);
                    if (ctx.method !== 'publickey') return ctx.reject(['publickey'], true);
                    logger.debug("auth context:", ctx);
                    user = await User.findOne({ uid: ctx.username });
                    const key = ssh2.utils.parseKey(user.sshPublicKey);
                    if (ctx.key.algo !== key.type) {
                        logger.error("Public key algorithm mismatch");
                        return ctx.reject();
                    }
                    if (!checkValue(ctx.key.data, key.getPublicSSH())) {
                        logger.error("Public key mismatch");
                        return ctx.reject();
                    }
                    if (ctx.signature)
                        if (!key.verify(ctx.blob, ctx.signature)) {
                            logger.error("Unable to verify signature using stored public key for ", user.uid);
                            return ctx.reject();
                        }
                    return ctx.accept()
                })
                .on('ready', async () => {
                    var logger = mkLogger(`ready:${user.uid}`);
                    const { uidnumber: uid, gidnumber: gid } = user;

                    logger.info('Client authenticated!');
                    /**
                     * @todo make remote execution work
                     */
                    client.on('session', (accept, reject) => {
                        const session = accept();
                        session.once('exec', (accept, reject, info) => {
                            const [command, ...args] = info.command.split(' ');
                            var logger = mkLogger(`exec:${user.uid}:${command}`);
                            logger.info('Client wants to execute: ' + util.inspect(command));
                            const stream = accept();
                            const logStream = new PassThrough();
                            let proc;

                            proc = spawn(command, args, {
                                uid,
                                gid,
                            })
                                .on('error', e => {
                                    logger.error(e);
                                    stream.end('' + e + EOL);
                                })

                            proc.stdout.pipe(logStream);
                            proc.stderr.pipe(logStream);
                            logStream.on('data', chunk => {
                                logger.trace('' + chunk);
                            });
                            logStream.on('end', () => {
                                logger.debug("Ending command execution");
                            });
                            logStream.on('error', e => {
                                logger.error(e);
                            });

                            logStream.pipe(stream);
                        });
                        session.once('shell', (accept, reject) => {
                            const logPrefix = `shell:${user.uid}:${user.loginShell}`;
                            var logger = mkLogger(logPrefix);
                            logger.info("Client wants to open a shell");
                            logger.debug("User shell:", user.loginShell);
                            if (!user.loginShell) {
                                logger.error("Invalid login shell for user:", user.loginShell);
                                return reject();
                            }
                            const stream = accept();

                            const logStream = new PassThrough();
                            const incomingLogStream = new PassThrough();
                            let cwd = user.homeDirectory;
                            const shell = spawn(user.loginShell, {
                                uid,
                                gid,
                                cwd
                            });
                            const transform = new Transform({
                                transform(chunk, encoding, callback) {
                                    callback(null, chunk.toString() + `${EOL}${user.uid}@bizi-ldap:${cwd}: `);
                                }
                            })
                            logStream.write(`Welcome to ${serverName}, ${user.uid}`);
                            shell.stdout.pipe(logStream);
                            shell.stderr.pipe(logStream);
                            stream.pipe(incomingLogStream);

                            const outboundLogger = mkLogger(`${logPrefix}:outbound`);
                            logStream.on('data', chunk => {
                                outboundLogger.trace('' + chunk);
                            });
                            logStream.on('end', () => {
                                outboundLogger.debug("Ending remote terminal session");
                            });
                            logStream.on('error', e => {
                                outboundLogger.error(e);
                            });
                            logStream.pipe(transform).pipe(stream);


                            const inboundLogger = mkLogger(`${logPrefix}:inbound`);
                            incomingLogStream.on('data', chunk => {
                                const str = '' + chunk;
                                if(!(str.trim().length)) logStream.write(' ');
                                inboundLogger.trace(str);
                                let newCwd;
                                if (str.indexOf('cd') === 0) {
                                    const [, newPath] = str.split(' ').map(r => r.trim());
                                    logger.debug({newPath});
                                    if (newPath)
                                        if (isAbsolute(newPath)) newCwd = newPath;
                                        else newCwd = join(cwd, newPath);
                                    if (fs.existsSync(newCwd)) cwd = newCwd;
                                    else logger.error(newCwd, "does not exist");
                                    logger.debug({ cwd });
                                    logStream.write(' ');
                                }
                            });
                            incomingLogStream.on('end', () => {
                                inboundLogger.debug("Ending remote terminal session");
                            });
                            incomingLogStream.on('error', e => {
                                inboundLogger.error(e);
                            });
                            incomingLogStream.pipe(shell.stdin);


                        })
                    });
                    const net = require('net');
                    client.on('tcpip', (accept, reject, info) => {
                        logger.info("Opening tunnel from", `${info.srcIP}:${info.srcPort}`, "to", `${info.destIP}:${info.destPort}`);
                        const stream = accept();
                        const tcp = new net.Socket();
                        tcp.pipe(stream).pipe(tcp)

                        tcp.connect(info.destPort, info.destIP)
                            .on('close', () => logger.info("Connection closed"))
                            .on("error", e => {
                                const msg = "Connection error:";
                                logger.error(msg, e);

                                stream.end();
                            });
                    })


                })
                .on('error', logger.error)
                .on('close', () => {
                    logger.info('Client disconnected');
                });
        });
        const port = process.env.PORT || 22;
        logger.info("Binding to port", port);
        server.listen(port, () => {
            logger.info("SSH2 Server listening on port", port)
        });
        logger.info("Setup complete..");
    })
    .catch(e => {
        logger.fatal("Unable to start svc ERROR:", e);
        process.exit(1);
    })