import os from "node:os";
import path from "node:path";
import express, { Router } from "express";
import events from "node:events";
import stream from "node:stream";
import fs from "fs-extra";
import bodyParser from "body-parser";
import compression from "compression";
import {glob} from "glob";
import NodeMediaServer from "node-media-server";
import nms_core_logger from "node-media-server/src/node_core_logger.js";
import nms_ctx from "node-media-server/src/node_core_ctx.js";
import NodeFlvSession from "node-media-server/src/node_flv_session.js";
import NodeRtmpSession from "node-media-server/src/node_rtmp_session.js";
import core, { utils, Blocklist, WebServer, FFMPEGWrapper } from "@livestreamer/core";

const __dirname = import.meta.dirname;

const FETCH_TIMEOUT = 60 * 1000;
const THUMBNAIL_INTERVAL = 60 * 1000;
const DETECT_CROP = true;
// const LEVEL_CACHE_LIMIT = 60;

const SESSION_VARS = [
    "config",
    // "socket",
    // "res",
    "id",
    "ip",
    "TAG",
    // "handshakePayload",
    // "handshakeState",
    // "handshakeBytes",
    // "parserBuffer",
    // "parserState",
    // "parserBytes",
    // "parserBasicBytes",
    // "parserPacket",
    // "inPackets",
    // "inChunkSize",
    // "outChunkSize",
    "pingTime",
    // "pingTimeout",
    // "pingInterval",
    "isLocal",
    "isStarting",
    "isPublishing",
    "isPlaying",
    "isIdling",
    "isPause",
    "isReceiveAudio",
    "isReceiveVideo",
    // "metaData",
    // "aacSequenceHeader",
    // "avcSequenceHeader",
    "audioCodec",
    "audioCodecName",
    "audioProfileName",
    "audioSamplerate",
    "audioChannels",
    "videoCodec",
    "videoCodecName",
    "videoProfileName",
    "videoWidth",
    "videoHeight",
    "videoFps",
    "videoLevel",

    // "gopCacheEnable",
    // "rtmpGopCacheQueue",
    // "flvGopCacheQueue",

    // "ackSize",
    // "inAckSize",
    // "inLastAck",

    "appname",
    "streams",

    "playStreamId",
    "playStreamPath",
    "playArgs",

    "publishStreamId",
    "publishStreamPath",
    "publishArgs",

    "players",
    "numPlayCache",
    "startTimestamp",

    "live"
];

const session_json = (session)=>{
    var s = {};
    for (var k of SESSION_VARS) s[k] = session[k];
    s.rejected = !nms_ctx.sessions.has(session.id);
    return s;
}

const session_reject = (session, reason)=>{
    core.logger.warn(reason);
    session.reject();
}

/** @typedef {{b:string, name:string}} AudioConfig */
/** @typedef {{width:string, height:string, b:string, codec:string}} VideoConfig */
/** @typedef {{name:string, v:VideoConfig, a:AudioConfig}} StreamConfig */

/** @type {Record<PropertyKey,VideoConfig}} */
let VIDEO_CONFIGS = {
    "240p": { "height": 240, "b": "350k" },
    "360p": { "height": 360, "b": "800k" },
    "480p": { "height": 480, "b": "1200k" },
    "720p": { "height": 720, "b": "2000k" },
    "1080p": { "height": 1080, "b": "3000k" }
};

/** @type {Record<PropertyKey,AudioConfig}} */
let AUDIO_CONFIGS = {
    "low": { "name":"low", "b": "128k" },
    "high": { "name":"high","b": "160k" },
};

/** @type {StreamConfig[]} */
let STREAM_CONFIGS = [
    { name: "240p", v: VIDEO_CONFIGS["240p"], a: AUDIO_CONFIGS["low"] },
    { name: "360p", v: VIDEO_CONFIGS["360p"], a: AUDIO_CONFIGS["low"] },
    { name: "480p", v: VIDEO_CONFIGS["480p"], a: AUDIO_CONFIGS["high"] },
    { name: "720p", v: VIDEO_CONFIGS["720p"], a: AUDIO_CONFIGS["high"] },
    { name: "1080p", v: VIDEO_CONFIGS["1080p"], a: AUDIO_CONFIGS["high"] },
    // { "name": "original", "cv": "copy", "ca": "copy" } // produces lots of warnings like '[hls @ 000001df40781380] Stream 6 packet with pts 534360 has duration 0. The segment duration may not be precise'
];

const APPNAMES = new Set([
    "live", // local encoding server
    "livestream", // restream
    "private", // playlist items
    "internal", // internal
    "test" // test ^ merge with internal
]);

class MediaServerApp {

    /** @type {Record<PropertyKey,LiveSessionWrapper>} */
    lives = {};

    init() {
        this.blocklist_path = path.join(core.appdata_dir, "media-server-blocklist");
        this.media_dir = path.join(core.appdata_dir, "media");

        fs.mkdirSync(this.media_dir, {recursive:true});

        for (var [from, to] of Object.entries({"log":"info","error":"error","debug":"debug","ffdebug":"debug"})) {
            nms_core_logger[from]  = (...args)=>{
                core.logger[to](...args);
            }
        }
        
        this.blocklist = new Blocklist(this.blocklist_path);

        core.set_priority(process.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);

        core.ipc.respond("published_sessions", ()=>{
            return [...nms_ctx.sessions.values()].filter(s=>s.isPublishing).map(s=>session_json(s));
        });

        this.nms = new NodeMediaServer({
            rtmp: {
                port: core.conf["media-server.rtmp_port"],
                chunk_size: 60000,
                gop_cache: true,
                ping: 60,
                ping_timeout: 30
            },
        });

        this.exp = express();
        this.web = new WebServer(this.exp);
        
        this.exp.use(bodyParser.urlencoded({ extended: true }));
        /* app.all('*', (req, res, next) => {
            res.header('Access-Control-Allow-Origin', "*");
            res.header('Access-Control-Allow-Headers', 'Content-Type,Content-Length, Authorization, Accept,X-Requested-With');
            res.header('Access-Control-Allow-Methods', 'PUT,POST,GET,DELETE,OPTIONS');
            res.header('Access-Control-Allow-Credentials', true);
            req.method === 'OPTIONS' ? res.sendStatus(200) : next();
        }); */
        this.exp.get('*.flv', (req, res, next) => {
            req.nmsConnectionType = 'http';
            new NodeFlvSession({}, req, res).run();
        });

        this.web.wss.on("connection", (ws,req) => {
            req.nmsConnectionType = 'ws';
            new NodeFlvSession({}, req, ws).run();
        });
        nms_ctx.nodeEvent.on('postPlay', (id, args) => {
            nms_ctx.stat.accepted++;
        });
        nms_ctx.nodeEvent.on('postPublish', (id, args) => {
            nms_ctx.stat.accepted++;
        });
        nms_ctx.nodeEvent.on('doneConnect', (id, args) => {
            let session = nms_ctx.sessions.get(id);
            let socket = session instanceof NodeFlvSession ? session.req.socket : session.socket;
            nms_ctx.stat.inbytes += socket.bytesRead;
            nms_ctx.stat.outbytes += socket.bytesWritten;
        });

        this.media_router = Router();
        this.media_router.use(
            compression({
                threshold: 0,
                filter:(req,res)=>{
                    if (res.getHeaders()["content-type"] === "application/vnd.apple.mpegurl") return true;
                    return false;
                    // return !!req.url.match(/\.m3u8$/);
                }
            })
        );
        this.media_router.get("/live/:id/:v.m3u8", async (req, res, next)=>{
            var {id, v} = req.params;
            var live = this.lives[id];
            if (v !== "master") {
                if (live) {
                    res.set('cache-control', 'no-store');
                    if (live.levels[v]) {
                        return await live.levels[v].fetch(req, res);
                    }
                } else {
                    var f = path.join(this.media_dir, `live/${id}/${v}.vod.m3u8`);
                    if (await fs.exists(f)) {
                        fs.createReadStream(path.join(this.media_dir, `live/${id}/${v}.vod.m3u8`), {encoding: 'utf8'})
                            .pipe(new stream.Transform({
                                transform(chunk, encoding, callback) {
                                    callback(null, chunk);
                                },
                                flush(callback) {
                                    this.push("\n#EXT-X-ENDLIST\n");
                                    callback();
                                }
                            }))
                            .pipe(res);
                        // var f = await fs.readFile(path.join(this.media_dir, `live/${id}/${v}.vod.m3u8`), "utf8");
                        // f += "\n#EXT-X-ENDLIST\n";
                        res.header("content-type", "application/vnd.apple.mpegurl");
                        // res.send(f);
                        return;
                    }
                    // console.debug(`redirecting ${req.url} -> ${new_url}`);
                    // req.url = new_url;
                }
            }
            next();
        });
        this.media_router.use("/", express.static(this.media_dir, {
            maxAge: "2y",
            etag: false,
            setHeaders: (res, file_path, stat) => {
                res.removeHeader("connection");
                // var metadata = await fs.readFile(file_path+".metadata.json", "utf8").catch(()=>{});
                // if (metadata) res.setHeader("segment-metadata", metadata);
            }
        }));
        this.exp.use("/media", this.media_router);
		this.exp.use('/', express.static(path.join(__dirname, "public_html")));
        this.exp.use('/logo', express.static(path.resolve(core.conf["media-server.logo"])));
        this.exp.use('/conf', (req, res)=>{
            res.json({
                logo_url: core.conf["media-server.logo_url"]
            });
        });

        var main_streams = {};
        core.ipc.on("main.stream.started", (stream)=>{
            main_streams[stream.id] = stream;
        });
        core.ipc.on("main.stream.stopped", (stream_id)=>{
            var stream = main_streams[stream_id];
            if (!stream) return;
            for (var path of stream.internal_stream_paths) {
                var session = this.get_session_from_stream_path(path);
                if (session) session.stop();
            }
        })

        this.nms.on('preConnect', (id, args)=>{
            core.logger.debug(`[NodeEvent on preConnect] id=${id} args=${JSON.stringify(args)}`);
            var session = this.get_session(id);
            var appname = args.app || (args.streamPath.split("/")[1]);
            if (!APPNAMES.has(appname)) {
                session_reject(session, `app '${appname}' does not exist.`);
            }
            if (!this.blocklist.is_valid(session.ip)) {
                session_reject(session, `blocked '${session.ip}' trying to connect.`);
            }
        });
        this.nms.on('postConnect', (id, args)=>{
            core.logger.debug(`[NodeEvent on postConnect] id=${id} args=${JSON.stringify(args)}`);
            // var session = this.get_session(id);
        });
        this.nms.on('doneConnect', (id, args)=>{
            core.logger.debug(`[NodeEvent on doneConnect] id=${id} args=${JSON.stringify(args)}`);
            // var session = this.get_session(id);
        });
        //-------------------------------------------------
        this.nms.on('prePlay', (id, StreamPath, args)=>{
            core.logger.debug(`[NodeEvent on prePlay] id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
            var session = this.get_session(id);
            core.ipc.send("main", "media-server.pre-play", session_json(session));
        });
        this.nms.on('postPlay', (id, StreamPath, args)=>{
            core.logger.debug(`[NodeEvent on postPlay] id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
            var session = this.get_session(id);
        });
        this.nms.on('donePlay', (id, StreamPath, args)=>{
            core.logger.debug(`[NodeEvent on donePlay] id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
            var session = this.get_session(id);
        });
        //-------------------------------------------------
        this.nms.on('prePublish', (id, StreamPath, args)=>{
            core.logger.debug(`[NodeEvent on prePublish] id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
            var session = this.get_session(id);
            if (!StreamPath.split("/").pop()) session.reject();
            // var key = args.key || StreamPath.replace(/^\/+/, "").replace(/\/+$/, "")
            /* if (core.conf["media-server.test_key"] && args.test_key !== core.conf["media-server.test_key"]) {
                reject(session, `Blocked '${session.ip}' publishing, bad test_key.`);
            } */
            core.ipc.emit("media-server.pre-publish", session_json(session));
        });
        this.nms.on('postPublish', async (id, StreamPath, args)=>{
            core.logger.debug(`[NodeEvent on postPublish] id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
            var session = this.get_session(id);
            core.ipc.emit("media-server.post-publish", session_json(session));
            await session_ready(session).catch(()=>{
                core.logger.error("No video and audio stream detected.");
                return;
            });
            if (!session.isPublishing || !session.publishStreamPath) {
                console.warn(`Session probably just ended but still sending chunks, ignoring...`, id);
                return;
            }
            if (session.appname === "live") {
                new LiveSessionWrapper(session);
            }
            core.ipc.emit("media-server.metadata-publish", session_json(session));
        });

        this.nms.on('donePublish', async(id, StreamPath, args)=>{
            core.logger.debug(`[NodeEvent on donePublish] id=${id} StreamPath=${StreamPath} args=${JSON.stringify(args)}`);
            var session = this.get_session(id);
            if (session.live && this.lives[session.live.id]) await this.lives[session.live.id].destroy();
            core.ipc.emit("media-server.done-publish", session_json(session));
        });

        var interval = new utils.Interval(()=>{
            this.cleanup_media();
        }, ()=>core.conf["media-server.media-cleanup-interval"] * 1000);

        this.cleanup_media();

        this.nms.run();
    }

    stop_session(id) {
        var session = this.get_session(id);
        if (session) session.stop();
    }

    /** @return {(NodeRtmpSession | NodeFlvSession)} */
    get_session(id) {
        return this.nms.getSession(id);
    }

    /** @return {(NodeRtmpSession | NodeFlvSession)} */
    get_session_from_stream_path(path) {
        for (var session of nms_ctx.sessions.values()) {
            if (session.publishStreamPath === path) {
                return session;
            }
        }
    }

    async cleanup_media() {
        var dirs = (await glob("*/*", {cwd: this.media_dir, stat: true, withFileTypes: true }));
        dirs.reverse();
        var now = Date.now();
        for (var dir of dirs) {
            var files = (await glob("*", {cwd: dir.fullpath(), stat: true, withFileTypes: true }));
            var f = files.sort((a,b)=>b.mtimeMs-a.mtimeMs)[0]; // get last modified file.
            if (!f) continue;
            if (now > f.mtimeMs + (core.conf["media-server.media_expire_time"] * 1000)) {
                await fs.rm(dir.fullpath(), { recursive: true });
            }
        }
    }

    async destroy() {
        for (var live of Object.values(this.lives)) {
            await live.destroy();
        }
        await this.web.destroy();
    }
}

/** @param {NodeRtmpSession} session */
function session_ready(session, timeout=20*1000) {
    let give_up_timeout, check_interval;
    return new Promise((resolve, reject)=>{
        let check = ()=>{
            if (!session.isPublishing) reject();
            if (session.videoCodec && session.audioCodec) resolve();
        };
        check_interval = setInterval(check, 100);
        check();
        if (timeout) give_up_timeout = setTimeout(reject, timeout);
    }).finally(()=>{
        clearTimeout(give_up_timeout);
        clearInterval(check_interval);
    })
}

class LiveSessionWrapper extends events.EventEmitter {
    ffmpeg;
    /** @type {Record<PropertyKey, LevelM3U8Manifest>} */
    levels = {};
    metadata = {};
    session;

    /** @param {NodeRtmpSession} session */
    constructor(session) {
        super();
        this.session = session;
        this.ffmpeg = new FFMPEGWrapper();
        var [_, appname, id] = session.publishStreamPath.split("/");
        this.appname = appname;
        this.id = id;
        this.dir = path.join(app.media_dir, appname, id);
        this.thumbnails_dir = path.join(this.dir, "thumbnails");
        app.lives[id] = this;
        session.live = {
            id,
            url:`${core.url}/media-server/player/index.html?id=${id}`,
        };
        this.init();
    }
    
    async init() {

        await fs.mkdir(this.dir, {recursive:true});
        await fs.mkdir(this.thumbnails_dir, {recursive:true});
        
        let min_height = Math.max(Math.min(...STREAM_CONFIGS.map(c=>c.v.height).filter(c=>c)), this.session.videoHeight || 720);
        this.configs = STREAM_CONFIGS.filter(c=>!c.v.height || c.v.height <= min_height).slice(-4);
        this.use_hardware = !!core.conf["media-server.use_hardware"];
        this.use_hevc = core.conf["media-server.use_hevc"];
        this.hls_list_size = core.conf["media-server.hls_list_size"];
        this.hls_max_duration = core.conf["media-server.hls_max_duration"];
        this.segment_duration = +core.conf["media-server.hls_segment_duration"];

        for (var c of this.configs) {
            this.levels[c.name] = new LevelM3U8Manifest(this, c);
        }

        var t = 0;
        var last_thumbnail_ts = 0;
        var create_thumbnail = async()=>{
            var ts = Date.now();
            if  ((ts-last_thumbnail_ts) < THUMBNAIL_INTERVAL) return;
            last_thumbnail_ts = ts;
            var level = this.last_level;
            var thumbnail_name = `${t}.webp`;
            var thumbnail_path = path.join(this.thumbnails_dir, thumbnail_name);
            var ffmpeg_args = [];
            if (level.init_uri) {
                var init_filename = path.join(this.dir, level.init_uri);
                ffmpeg_args.push("-i", `concat:${init_filename}|${this.last_segment_filename}`); 
            } else {
                ffmpeg_args.push("-i", this.last_segment_filename);
            }
            ffmpeg_args.push(
                "-quality", "70",
                "-vf", "scale=-1:360",
                "-vframes", "1",
                "-y",
                thumbnail_path
            );
            await utils.execa(core.conf["core.ffmpeg_executable"], ffmpeg_args);
            this.session.live.thumbnail_url = `${core.url}/media-server/media/${this.appname}/${this.id}/thumbnails/${thumbnail_name}`;
            t++;
        };
        this.last_level.on("new_segment", create_thumbnail);

        this.start();

        core.ipc.emit("media-server.live-publish");
    }

    start(force_software) {

        let ffmpeg_args = [
            "-strict", "experimental"
        ];
        
        const use_hardware = !force_software && this.use_hardware;
        const hwaccel = use_hardware && core.conf["core.ffmpeg_hwaccel"];
        const hwenc = use_hardware && core.conf["core.ffmpeg_hwenc"];
        if (hwaccel) {
            ffmpeg_args.push(
                "-hwaccel", hwaccel,
                "-hwaccel_output_format", hwaccel,
                // `-extra_hw_frames`, `10` // fucks up
            );
        }
        ffmpeg_args.push(
            "-fflags", "+igndts+genpts",
            `-dts_delta_threshold`, `0`
        );
        ffmpeg_args.push(
            // `-re`,
            // "-f", "flv",
            "-i", `rtmp://127.0.0.1:${core.conf["media-server.rtmp_port"]}${this.session.publishStreamPath}`,
            `-noautoscale`,
            `-ar`, `44100`,
            `-ac`, `2`,
            // `-pix_fmt`, `yuv420p`, // fucks up hw scaler
            `-bsf:v`, this.use_hevc ? `hevc_mp4toannexb` : `h264_mp4toannexb`,
            `-bsf:a`, `aac_adtstoasc`,
            // `-vf`, `setpts=PTS-STARTPTS`,
            // `-af`, `asetpts=PTS-STARTPTS`,
            `-async`, `1`,

            // `-vsync`, `2`,
            // `-fpsmax`, `60`, // max fps
            // `-avoid_negative_ts`, `make_zero`,
            // `-vsync`, `cfr`,
            // `-r`, "60",
            
            // `-fps_mode`, `passthrough`,
            // `-vsync`, `0`,

            // `-movflags`,` +faststart`,
            "-force_key_frames", `expr:gte(t,n_forced*${core.conf["media-server.keyframe_interval"]})`, // keyframe every 2 seconds.
        );
        if (use_hardware) {
            ffmpeg_args.push(
                // "-r", "30",
                `-no-scenecut`, `1`,
                `-rc`, `cbr_hq`,
                // `-rc`, `constqp`,
                // `-bf`, `2`, // 2 is default
                `-forced-idr`, `1`,
                `-rc-lookahead`, `30`,
            );
        } else {
            ffmpeg_args.push(
                `-enc_time_base`, `-1`, //           <-- this
                `-video_track_timescale`, `1000`, // <-- and this seems to fix all dts errors
                `-vsync`, `2`,
            )
        }
        ffmpeg_args.push(
            // `-preset`, `ultrafast`
            `-preset`, hwenc ? `p7` : `medium`
        );
        // var v_configs = [...new Set(this.configs.map(c=>c.v))];
        // var a_configs = [...new Set(this.configs.map(c=>c.a))];

        var vid = `0:v:0`;
        // var aid = `0:a:0`;
        var filter_complex = [];
        var vmap = {};
        var video_configs = [...new Set(this.configs.map(c=>c.v))];

        // var amap = {}
        // var cas = [...new Set(this.configs.map(c=>c.a))];
        // var fix_id = (id)=>String(id).split(/[^a-z0-9]+/gi).filter(a=>a).join("_");

        filter_complex.push(
            `[${vid}]split=${video_configs.length}${video_configs.map((c,i)=>`[v${i}]`).join("")}`
        );
        video_configs.forEach((cv,i)=>{
            var needs_scaling = (()=>{
                let check = {width:this.session.videoWidth, height:this.session.videoHeight}
                for (var k of ["width", "height"]) {
                    if (cv[k] && check[k] != cv[k]) return true;
                }
                return false;
            })();
            let graph;
            let configs = this.configs.filter(c=>c.v === cv);
            let out = `v${i}`;
            if (needs_scaling) {
                let s = `${cv.width||-2}:${cv.height||-2}`;
                graph = [
                    hwenc ? `scale_${core.conf["core.ffmpeg_hwaccel"]}=${s}` : `scale=${s}`
                ].join(",");
                out = `vscaled${i}`;
                filter_complex.push(`[v${i}]${graph}[${out}]`);
            }
            for (let c of configs) {
                vmap[c.name] = `[${out}]`;
            }
        });
        ffmpeg_args.push("-filter_complex", filter_complex.join(";"));

        this.configs.forEach((c,i)=>{
            ffmpeg_args.push("-map", vmap[c.name]);
            ffmpeg_args.push(
                `-c:v:${i}`, c.v.codec || (hwenc ? `${this.use_hevc?"hevc":"h264"}_${hwenc}` : this.use_hevc ? `libx265` : `libx264`)
            );
            ffmpeg_args.push(
                `-b:v:${i}`, c.v.b,
                `-maxrate:v:${i}`, c.v.b,
                `-bufsize:v:${i}`, c.v.b,
            );
            // if (hwenc) {
            //     ffmpeg_args.push(
            //         // "-copyts",
            //         // `-crf`, `22`,
            //         // `-cq:v:${i}`, c.cq,
            //         // `-qmin:v:${i}`, c.cq,
            //         // `-qmax:v:${i}`, c.cq,
            //         // `-qp:v:${i}`, c.qp
            //     );
            // }
            ffmpeg_args.push("-map", "0:a:0");
            ffmpeg_args.push(`-c:a:${i}`, "aac");
            if (c.a.b) {
                ffmpeg_args.push(`-b:a:${i}`, c.a.b);
            }
            // ffmpeg_args.push(
            //     `-filter:a:${i}`, `asetpts=PTS-STARTPTS`
            // );
        });
        // var fix_name = /** @param {string} s */(s)=>s.trim().replace(/\s+/g, "-").toLowerCase();
        ffmpeg_args.push(
            `-var_stream_map`, this.configs.map((c,i)=>`v:${i},a:${i},name:${encodeURIComponent(c.name)}`).join(" "),
            `-hls_list_size`, this.hls_list_size,
            // `-hls_playlist_type`, `event`,
            `-threads`, `0`,
            `-f`, `hls`,
            `-hls_segment_type`, this.use_hevc ? `fmp4` : `mpegts`,
            // `-hls_init_time`, `1`,
            `-hls_time`, `${this.segment_duration}`,
            // `-hls_flags`, `+delete_segments`, // at some point I want to keep segments and serve atleast several hours of stream // +independent_segments
            `-master_pl_name`, `master.m3u8`,
            `-y`, `%v.m3u8`
        );

        core.logger.info(`ffmpeg command:\n ffmpeg ${ffmpeg_args.join(" ")}`);
        this.ffmpeg.start(ffmpeg_args, {cwd: this.dir});
        var crop, m;
        this.ffmpeg.on("line", (line)=>{
            if (DETECT_CROP) {
                if (m = line.match(/^\[hls @ .+?\] Opening '(.+?)' for writing$/)) {
                    if (crop) this.set_metadata(m[1], "crop", crop);
                    // return;
                }
                if (m = line.match(/crop=(.+)/)) {
                    crop = m[1];
                    return;
                }
            }
            core.logger.debug(line);
        });
        /* this.trans.catch((e)=>{
            if (!this.#ended && use_hardware) {
                core.logger.info(`Hardware mode failed, trying force_software=true...`)
                this.start(true);
            }
        }) */
    }

    get last_level() {
        var k = String(Object.keys(this.levels).pop());
        return this.levels[k];
    }

    get last_segment_filename() {
        var last_segment_uri = this.last_level.last_segment_uri;
        if (last_segment_uri) return path.join(this.dir, last_segment_uri);
    }

    set_metadata(segment_uri, k,v) {
        if (!this.metadata[segment_uri]) this.metadata[segment_uri] = {};
        this.metadata[segment_uri][k] = v;
        fs.writeFile(path.join(app.media_dir, this.appname, this.id, segment_uri+".metadata.json"), JSON.stringify(this.metadata[segment_uri]), "utf8");
    }

    async destroy() {
        this.emit("destroy");
        clearInterval(this.update_interval);
        for (var v in this.levels) {
            await this.levels[v].destroy();
        }
        delete app.lives[this.id];
        if (this.ffmpeg) this.ffmpeg.destroy();
    }
}

/** @typedef {{i:number, duration:number, uri:string}} Segment */
class LevelM3U8Manifest extends events.EventEmitter {
    len = 0;
    sep = "\n".charCodeAt(0);
    /** @type {Segment[]} */
    #segments = [];
    #bitrates = [];
    #destroyed = false;
    // parser = new m3u8Parser.Parser();
    // #cache = new utils.Cache(LEVEL_CACHE_LIMIT);

    /** @param {LiveSessionWrapper} live @param {StreamConfig} config */
    constructor(live, config) {
        super();
        this.live = live;
        this.config = config;
        this.live_filename = path.join(this.live.dir, config.name+".m3u8");
        this.filename = path.join(this.live.dir, config.name+".vod.m3u8");
        var last_mtime;
        this.interval = setInterval(async()=>{
            var stat = await fs.stat(this.live_filename).catch(()=>{});
            if (stat && stat.mtime != last_mtime) {
                last_mtime = stat.mtime;
                this.#update();
            }
        }, 500);
    }

    get last_segment() {
        return this.#segments[this.#segments.length-1];
    }
    get last_segment_uri() {
        var s = this.last_segment;
        return s ? s.uri : null;
    }
    get next_segment_index() { return this.#segments.length; }

    get next_segment_uri() { return `${this.config.name}${this.next_segment_index}.${this.live.use_hevc?"m4s":"ts"}`; }

    async #update() {
        /** @type {string} */
        var str = await fs.readFile(this.live_filename, {encoding:"utf-8"}).catch(()=>{});
        var matches = [...str.matchAll(/^#EXTINF:(.+?),\n(.+)$/gm)];
        var segments = matches.map(m=>({
            duration:+m[1],
            uri:m[2],
            i:+m[2].slice(this.config.name.length).split(".")[0]
        }));
        if (segments.length) {
            if (this.#segments.length == 0) {
                var init = str.match(/^#EXT-X-MAP:URI="(.+)"$/m);
                if (init) this.init_uri = init[1];
                await this.#append(this.#render_header());
            }
            for (var i = this.#segments.length; i < segments[0].i; i++) {
                console.warn(`missing segment ${i}, generating...`);
                await this.#append(`#EXT-X-DISCONTINUITY`);
                var last_segment = this.last_segment;
                await this.#add_segment({
                    i: this.next_segment_index,
                    uri: this.next_segment_uri,
                    duration: last_segment ? last_segment.duration : this.live.segment_duration,
                });
                await this.#append(`#EXT-X-DISCONTINUITY`);
            }
        }
        for (var s of segments) {
            if (s.i < this.next_segment_index) continue;
            await this.#add_segment(s);
        }
    }

    /** @param {Segment} segment */
    async #add_segment(segment) {
        this.#segments.push(segment);
        var stat = await fs.stat(path.join(this.live.dir, segment.uri)).catch(()=>{});
        if (stat) {
            let bitrate = (stat.size * 8) / segment.duration;
            this.#bitrates.push(bitrate);
            while (this.#bitrates.length > 128) this.#bitrates.shift();
            core.logger.debug(`segment ${segment.uri} bitrate: ${Math.round(bitrate/1024)}kbps | overall_avg: ${Math.round(utils.average(this.#bitrates)/1024)}kbps`);
        }
        await this.#append(`#EXTINF:${segment.duration.toFixed(6)},\n${segment.uri}\n`);
        this.emit("new_segment", segment);
    }

    async #append(str) {
        await fs.appendFile(this.filename, str, "utf8");
        this.live.emit("update");
        this.emit("update");
    }
    #render_header(media_sequence) {
        var str = `#EXTM3U\n`;
        str += `#EXT-X-VERSION:9\n`;
        str += `#EXT-X-TARGETDURATION:${this.live.segment_duration.toFixed(6)}\n`;
        str += `#EXT-X-MEDIA-SEQUENCE:${media_sequence||0}\n`;
        if (this.init_uri) {
            str += `#EXT-X-MAP:URI="${this.init_uri}"\n`;
        }
        return str;
    }
    #render(_HLS_msn, _HLS_skip) {
        var min_segments = this.live.hls_list_size;
        var max_segments = Math.max(min_segments, Math.ceil(this.live.hls_max_duration / this.live.segment_duration));
        var end = this.#segments.length;
        var media_sequence = Math.max(0, end - max_segments);
        var start = media_sequence;
        
        var lines = this.#render_header(media_sequence);
        
        lines += `#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=YES,PART-HOLD-BACK=1.0,CAN-SKIP-UNTIL=${(this.live.segment_duration*6).toFixed(1)}\n`;

        if (_HLS_skip) {
            let skipped_segments = utils.clamp(end - min_segments, 0, (max_segments-min_segments));
            start += skipped_segments;
            lines += `#EXT-X-SKIP:SKIPPED-SEGMENTS=${skipped_segments}\n`;
        }
        this.#segments.slice(start, end).forEach(s=>{
            lines += `#EXTINF:${s.duration.toFixed(6)},\n${s.uri}\n`;
        });
        return lines;
    }
    /** @param {import("express").Request} req @param {import("express").Response} res */
    async fetch(req, res) {
        var _HLS_msn = req.query._HLS_msn || 0;
        var _HLS_skip = req.query._HLS_skip || false;
        var ts = Date.now();
        while (!this.#segments[_HLS_msn] && !this.#destroyed) {
            await new Promise(r=>this.once("update", r));
            if (Date.now() > ts + FETCH_TIMEOUT) throw new Error("This is taking ages.");
        }
        res.header("content-type", "application/vnd.apple.mpegurl");
        res.send(this.#render(_HLS_msn, _HLS_skip));
    }

    async destroy() {
        this.#destroyed = true;
        await this.#append(`#EXT-X-ENDLIST\n`);
        clearInterval(this.interval);
    }
}

const app = new MediaServerApp();
core.init("media-server", app);

export default app;