import { dom_utils, utils, $, Hls, videojs } from "./core.js";
import './app.scss';

var conf;
var time_display_modes = [
    {
        "label": "Live Time",
        "icon": `<i class="far fa-clock"></i>`
    },
    {
        "label": "Time Remaining",
        "icon": `<i class="far fa-hourglass"></i>`
    }
];

var crop_modes = [
    {
        "label": "Aspect Ratio: Default",
        "icon": `-`,
        "value":0
    },
    {
        "label": "Aspect Ratio: Automatic Detection",
        "icon": `AUTO`,
        "value":"auto"
    },
    {
        "label": "Aspect Ratio: 16:9 -> 4:3",
        "icon": `4:3`,
        "value": 4/3
    },
    {
        "label": "Aspect Ratio: 4:3 -> 16:9",
        "icon": `16:9`,
        "value": 16/9
    }
];

const DEBUG = false;
var REGION_BUFFER = 30;
var MIN_REGIONS_FIRST_CROP = 0;
const CROP_DETECT_INTERVAL = 100;
const VIDEO_UI_UPDATE_INTERVAL = 100;
const IS_EMBED = window.parent !== window.self;

var settings = new dom_utils.LocalStorageBucket("player", {
    time_display_mode: 0,
    volume: 1,
    crop_mode: "auto",
});

if (DEBUG) document.body.style.background = "blue";
if (IS_EMBED) document.body.classList.add("embedded");

class App {
    /** @type {VideoPlayer} */
    player;

    async init() {
        conf = await (await fetch("../conf")).json();

        var params = new URLSearchParams(location.search);
        var autoplay = params.get("autoplay") == "1"

        var src = new URL(`../media/live/${params.get("id")}/master.m3u8`, window.location.origin+window.location.pathname).toString();
        console.log(src);

        var messenger = new dom_utils.WindowCommunicator();
        messenger.on("set_aspect_ratio", (ar)=>{
            this.aspect_ratio = ar;
            return true;
        });
        this.play_button = $(
            `<div class="play-button" style="z-index:999">
                <div class="play"><i class="fas fa-play"></i></div>
            </div>`
        )[0];
        this.play_button.onclick = (e)=>{
            if (this.player) this.player.player.play();
            else new VideoPlayer(src, true);
        }
        document.body.append(this.play_button);
        new VideoPlayer(src, autoplay);
        this.showing_play_overlay = false;
        this.update();
    }

    update() {
        var player = this.player;
        var show = !player || !player.initialized;
        this.play_button.querySelector(".play").style.display = show ? "" :  "none";
        if (show != this.showing_play_overlay) {
            this.play_button.style.pointerEvents = show ? "" : "none";
            if (show) $(this.play_button).fadeIn(200);
            else $(this.play_button).fadeOut(200);
        }
        // console.log(e, videoWasPlaying);
        this.showing_play_overlay = show;
        player.update();
    }
}

class VideoPlayer {
    /** @type {HTMLVideoElement} */
    video_el;
    /** @type {Hls}*/
    hls;
    /** @type {import("video.js/dist/types/player").default}*/
    player;
    initialized = false;
    update_interval_id;

    constructor(src, autoplay) {
        app.player = this;
        this.src = src;
        this.video_el = $(`<video class="video-js" preload="auto" width="1280" height="720"></video>`)[0];

        document.body.append(this.video_el);
        this.video_el.addEventListener("error", (e)=>{
            console.log(e);
        });
        if (Hls.isSupported()) {
            this.init_player(autoplay);
        } else if (this.video_el.canPlayType('application/vnd.apple.mpegurl')) {
            this.video_el.src = src;
        }
        // this.video_wrapper = $(`<div class="video-wrapper">`)[0];
        // this.video_el.after(this.video_wrapper)
        // this.video_wrapper.append(this.video_el);
    }

    update = dom_utils.debounce_next_frame(()=>this.__update())

    __update() {
        if (!this.player) return;

        var d = this.get_time_until_live_edge_area(true);
        var behindLiveEdge = this.liveTracker.behindLiveEdge();
        
        var rate = this.player.playbackRate();
        var new_rate;
        var at_live_edge = d <= 0 && !behindLiveEdge;
        // if (rate === -1) {
        //   new_rate = at_live_edge ? 1.0 : 1.5;
        // } else {
        new_rate = at_live_edge ? Math.min(1, rate) : rate;
        // }
        if (new_rate != rate) {
            this.player.playbackRate(new_rate);
        }

        // console.log("liveTracker.behindLiveEdge()", liveTracker.behindLiveEdge())
        var stl_text;
        if (this.liveTracker.behindLiveEdge()) {
            if (this.is_mobile && settings.get("time_display_mode") == 0) {
                stl_text = "["+this.get_live_time(0, this.player.currentTime())+"]"
            } else {
                stl_text = `[-${videojs.time.formatTime(this.get_time_until_live_edge_area())}]`
            }
        } else {
            stl_text = "LIVE"
        }
        if (this.seekToLive.last_text != stl_text) {
            this.seekToLive.last_text = stl_text
            this.seekToLive.textEl_.innerHTML = stl_text;
        }
        
        var is_live = this.liveTracker.isLive();
        if (is_live) this.timeDisplayToggle.show();
        else this.timeDisplayToggle.hide();

        if (!this.pause_button) {
            this.pause_button = $(
                `<div class="play-button">
                    <div class="pause"><i class="fas fa-pause"></i></div>
                    <div class="ended"><div style="padding:10px">The stream has ended.</div><i class="fas fa-redo"></i></div>
                </div>`
            )[0];
            this.pause_button.onclick = ()=>this.player.play();
        }
        var seeking  = this.player.scrubbing() || this.player.seeking();
        var videoWasPlaying = this.player.controlBar.progressControl.seekBar.videoWasPlaying;
        var ended = this.player.ended();
        var paused = !ended && this.player.hasStarted() && this.player.paused() && (!seeking || !videoWasPlaying);
        this.pause_button.querySelector(".pause").style.display = paused ? "" : "none";
        this.pause_button.querySelector(".ended").style.display = ended ? "" : "none";
        if (!ended && !paused) {
            this.pause_button.remove();
        } else if (!this.pause_button.parentElement) {
            this.video_el.after(this.pause_button);
        }
        this.update_aspect_ratio();
    }

    async update_aspect_ratio() {
        var ar = settings.get("crop_mode");
        if (DEBUG) {
            this.video_el.style.background = "red";
        }
        var remove_crop_detect = ()=> {
            if (!this.crop_detect) return;
            this.crop_detect.dispose();
            this.crop_detect = null;
        };
        if (ar == "auto") {
            var dims_hash = JSON.stringify([this.video_el.videoWidth, this.video_el.videoHeight]);
            if (dims_hash !== this._last_dims_hash) remove_crop_detect();
            this._last_dims_hash = dims_hash;
            if (!this.crop_detect) this.crop_detect = new CropDetect(this.video_el);
        } else {
            remove_crop_detect();
            if (ar) {
                var scale = 1;
                var height = window.innerWidth / ar;
                var correction_ratio = window.innerHeight / height;
                scale = utils.clamp((ar * correction_ratio), 1, 4/3);
                this.video_el.style.transform = `scale(${scale})`;
            } else {
                this.video_el.style.transform = ``;
            }
        }
    }
    
    get_preferred_level() {
        var level = localStorage.getItem("level");
        if (level == null) level = -1;
        return +level;
    }

    init_player(autoplay) {
        let _this = this;
        var Button = videojs.getComponent("Button");
        var MenuButton = videojs.getComponent("MenuButton");
        var MenuItem = videojs.getComponent("MenuItem");
        var ProgressControl = videojs.getComponent("ProgressControl");
        var VolumeControl = videojs.getComponent("VolumeControl");
        var MouseTimeDisplay = videojs.getComponent("MouseTimeDisplay");
        var PlaybackRateMenuButton = videojs.getComponent("PlaybackRateMenuButton");
        var PlaybackRateMenuItem = videojs.getComponent("PlaybackRateMenuItem");

        var ProgressControl_enable = ProgressControl.prototype.enable;
        ProgressControl.prototype.enable = function(...args) {
            this.handleMouseMove = ProgressControl.prototype.handleMouseMove;
            return ProgressControl_enable.apply(this, args);
        }
        
        // var VolumeControl_constructor = VolumeControl.prototype.constructor;
        // VolumeControl.prototype.constructor = function(...args) {
        //   var ret = VolumeControl_constructor.apply(this, args);
        //   this.throttledHandleMouseMove = this.handleMouseMove;
        //   return ret;
        // };

        // var MouseTimeDisplay_constructor = MouseTimeDisplay.prototype.constructor;
        
        // MouseTimeDisplay.prototype.constructor = function(...args) {
        //   debugger;
        //   var ret = MouseTimeDisplay_constructor.apply(this, args);
        //   this.el_.setAttribute('draggable', false)
        //   this.el_.ondragstart = ()=>false;
        //   return ret;
        // };

        function disable_drag(el) {
            el.setAttribute('draggable', false);
            el.ondragstart = (e)=>{
                e.preventDefault();
                return false;
            }
        }
        function pauseEvent(e){
            if(e.stopPropagation) e.stopPropagation();
            if(e.preventDefault) e.preventDefault();
            e.cancelBubble=true;
            e.returnValue=false;
            return false;
        }

        class StopButton extends Button {
            constructor(player, options) {
                super(player, options);
                this.stop_icon = $(`<i class="fas fa-stop" style="font-size: 140%;">`)[0];
                this.el_.prepend(this.stop_icon);
                this.controlText("Stop");
            }
            handleClick(event) {
                app.player.destroy()
            }
            buildCSSClass() {
                return `vjs-stop-control vjs-control vjs-button ${super.buildCSSClass()}`;
            }
        }
        videojs.registerComponent("stopButton", StopButton);
        class HLSSelectMenuButton extends MenuButton {
            constructor(player, options) {
                super(player, {
                    levels: [],
                    title: "Quality",
                    className: "", 
                    ...options,
                });
                var update_label = (level)=>{
                    var data = levels.find(l=>l.value == level);
                    this.q_label.innerHTML = data ? data.text : "-";
                }
                var levels = [];
                app.player.hls.on(Hls.Events.MANIFEST_PARSED, (event, data)=>{
                    levels = data.levels.map((l,i)=>{
                        var m = l.url[0].match(/([^/]+)\.[a-z0-9]+$/);
                        if (m) {
                            return {value:i, text:m[1], bitrate:l.bitrate}
                        }
                    }).filter(l=>l);
                    levels.push({value:-1, text:"AUTO", bitrate:0});
                    this.options_.levels = levels;
                    this.update();
                    update_label(levels[1].level);
                });
                app.player.hls.on(Hls.Events.LEVEL_SWITCHING, (event, data)=>{
                    update_label(data.level);
                });
                app.player.hls.on(Hls.Events.LEVEL_UPDATED, (event, data)=>{
                    update_label(data.level);
                });
                this.q_label = $(`<div>`)[0];
                this.menuButton_.el_.prepend(this.q_label);
                this.controlText("Quality");
                update_label(-1);
            }
            buildWrapperCSSClass() {
                return `vjs-level-select ${super.buildWrapperCSSClass()}`;
            }
            buildCSSClass() {
                return `vjs-level-select ${super.buildCSSClass()}`;
            }
            hide() {
                super.hide();
            }
            update() {
                super.update();
                this.update_selection();
            }
            update_selection(){
                for (var item of this.items) {
                    var level = app.player.get_preferred_level();
                    item.selected(item.level === level);
                }
            }
            createItems() {
                this.hideThreshold_ = 1;
                var levels = utils.sort([...this.options_.levels], l=>-l.bitrate);
                return levels.map((level)=>{
                    var item = new MenuItem(this.player_, { label: level.text, selectable: true });
                    item.level = level.value;
                    item.handleClick = ()=>{
                        app.player.hls.nextLevel = level.value;
                        localStorage.setItem("level", level.value);
                        this.update_selection();
                    };
                    return item;
                });
            }
        }
        videojs.registerComponent("hlsSelectMenuButton", HLSSelectMenuButton);
        class TimeDisplayToggle extends Button {
            constructor(player, options) {
                super(player, options);
                this.icon = document.createElement("div");
                this.icon.classList.add("icon");
                this.el_.prepend(this.icon);
                this.update();
            }
            handleClick(event) {
                settings.set("time_display_mode", (settings.get("time_display_mode")+1) % time_display_modes.length)
                this.update();
            }
            update() {
                // console.log("time_display_mode", time_display_mode)
                var c = time_display_modes[settings.get("time_display_mode")];
                this.icon.innerHTML = c.icon;
                this.controlText(`Time Display Mode: ${c.label}`);
            }
            buildCSSClass() {
                return `vjs-time-display-toggle vjs-control vjs-button ${super.buildCSSClass()}`;
            }
        }
        videojs.registerComponent("timeDisplayToggle", TimeDisplayToggle);
        
        class CropToggle extends Button {
            constructor(player, options) {
                super(player, options);
                this.icon = document.createElement("div");
                this.icon.classList.add("icon");
                this.el_.prepend(this.icon);
                this.update();
            }
            handleClick(event) {
                var c = (crop_modes.findIndex(m=>m.value == settings.get("crop_mode"))+1)%crop_modes.length;
                settings.set("crop_mode", crop_modes[c].value);
                this.update();
            }
            update() {
                var c = crop_modes.find(m=>m.value == settings.get("crop_mode"));
                if (!c) return;
                this.icon.innerHTML = c.icon;
                this.icon.dataset.ratio = c.icon;
                // if (c.value) this.icon.style.setProperty("--ratio", c.value);
                // else this.icon.style.removeProperty("--ratio");
                this.controlText(`${c.label}`);
            }
            buildCSSClass() {
                return `vjs-crop-toggle vjs-control vjs-button ${super.buildCSSClass()}`;
            }
        }
        videojs.registerComponent("cropToggle", CropToggle);

        this.hls = new Hls({
            manifestLoadPolicy: {
                default: {
                    maxTimeToFirstByteMs: Infinity,
                    maxLoadTimeMs: 20000,
                    timeoutRetry: {
                        maxNumRetry: 5,
                        retryDelayMs: 0,
                        maxRetryDelayMs: 0,
                    },
                    errorRetry: {
                        maxNumRetry: 5,
                        retryDelayMs: 1000,
                        maxRetryDelayMs: 8000,
                        shouldRetry: (retryConfig, retryCount, isTimeout, httpStatus,retry)=>{
                            if (httpStatus.code == 404) return true;
                            return retry;
                        }
                    },
                },
            },
            maxBufferSize: 2 * 1024 * 1024,
            maxBufferLength: 5, // minimum guaranteed buffer length
            maxMaxBufferLength: 15, // max seconds to buffer
            liveDurationInfinity: true,
            // liveSyncDurationCount: 3, // 3 by default, about 6 seconds.
            // progressive: true, // experimental
            lowLatencyMode: false,
            // maxLiveSyncPlaybackRate: 1.5,

            // -----
            // debug: true
        });
        
        this.hls.on(Hls.Events.MANIFEST_PARSED, (event, data)=>{
            var level = this.get_preferred_level();
            if (level >= 0) this.hls.nextLevel = level;
        });

        this.player = videojs(this.video_el, {
            // autoplay: true,
            // muted: true, 
            // volume:0,
            // fluid: true,
            playbackRates: [0.5, 1, 1.25, 1.5, 2], // , -1
            controls: true,
            responsive: true,
            liveui: true,
            enableSmoothSeeking: true,
            inactivityTimeout: 1000,
            
            // experimentalSvgIcons: true,
            liveTracker: {
                trackingThreshold: 0,
                liveTolerance: 10
                // trackingThreshold: 0,
                // liveTolerance: 0.5
            },
            controlBar: {
                progressControl: {
                    keepTooltipsInside: true
                },
                skipButtons: {
                    forward: 30,
                    backward: 10,
                },
                volumePanel: {
                    inline: true
                },
                children: [
                    "stopButton",
                    'playToggle',
                    'skipBackward',
                    'skipForward',
                    'volumePanel',
                    'currentTimeDisplay',
                    'timeDivider',
                    'durationDisplay',
                    'progressControl',
                    'liveDisplay',
                    'seekToLive',
                    'remainingTimeDisplay',
                    'customControlSpacer',
                    "timeDisplayToggle",
                    "cropToggle",
                    'playbackRateMenuButton',
                    'chaptersButton',
                    'descriptionsButton',
                    'subsCapsButton',
                    'audioTrackButton',
                    "hlsSelectMenuButton",
                    'pictureInPictureToggle',
                    'fullscreenToggle'
                ]
                /* volumePanel: {
                    inline: false,
                    vertical: true
                } */
            }
        });

        // player.on("seeked",(e)=>this.update_play_button(e));
        // seekBarPlayProgressBar.__proto__.update.apply(seekBarPlayProgressBar);

        var player_playbackRate = this.player.playbackRate;
        var auto_playback_rate = true;

        this.player.playbackRate = function(rate){
            if (rate === undefined) {
                if (auto_playback_rate) return -1;
                return player_playbackRate.apply(this);
            } else {
                auto_playback_rate = rate === -1;
                if (rate !== -1) return player_playbackRate.apply(this, [rate]);
            }
        }

        this.hls.loadSource(this.src);
        this.hls.attachMedia(this.video_el);

        // this.hls.media.srcObject.setLiveSeekableRange(0, 600)
        // this.hls.on(Hls.Events.ERROR, (...e)=>{
        //   console.error(e);
        // })

        this.player.on('volumechange', ()=>{
            settings.set("volume", this.player.muted() ? 0 : this.player.volume())
        });
        this.player.volume(settings.get("volume"));

        /** @type {import("video.js/dist/types/control-bar/control-bar").default}*/
        this.controlBar = this.player.controlBar;
        /** @type {import("video.js/dist/types/control-bar/seek-to-live").default}*/
        this.seekToLive = this.controlBar.getChild("SeekToLive");
        /** @type {import("video.js/dist/types/control-bar/fullscreen-toggle").default}*/
        this.fullscreenToggle = this.controlBar.getChild("FullscreenToggle");
        /** @type {import("video.js/dist/types/control-bar/volume-panel").default}*/
        this.volumePanel = this.controlBar.getChild("VolumePanel");
        /** @type {import("video.js/dist/types/control-bar/volume-control/volume-control").default}*/
        this.volumeControl = this.volumePanel.getChild("VolumeControl");
        /** @type {import("video.js/dist/types/control-bar/volume-control/volume-bar").default}*/
        this.volumeBar = this.volumeControl.getChild("VolumeBar");
        /** @type {TimeDisplayToggle} */
        this.timeDisplayToggle = this.controlBar.getChild("TimeDisplayToggle");
        /** @type {import("video.js/dist/types/control-bar/volume-control/mouse-volume-level-display").default}*/
        this.volumeBarMouseTimeDisplay = this.volumeBar.getChild('MouseVolumeLevelDisplay');
        /** @type {import("video.js/dist/types/control-bar/progress-control/progress-control").default}*/
        this.progressControl = this.controlBar.getChild('progressControl');
        /** @type {import("video.js/dist/types/control-bar/progress-control/seek-bar").default}*/
        this.seekBar = this.progressControl.getChild('seekBar');
        /** @type {import("video.js/dist/types/control-bar/progress-control/mouse-time-display").default}*/
        this.seekBarMouseTimeDisplay = this.seekBar.getChild('mouseTimeDisplay');
        /** @type {import("video.js/dist/types/control-bar/progress-control/play-progress-bar").default}*/
        this.seekBarPlayProgressBar = this.seekBar.getChild('playProgressBar');
        /** @type {import("video.js/dist/types/control-bar/playback-rate-menu/playback-rate-menu-button").default}*/
        this.controlplaybackRateMenuButton = this.controlBar.getChild('playbackRateMenuButton');
        /** @type {import("video.js/dist/types/live-tracker").default}*/
        this.liveTracker = this.player.liveTracker;

        this.controlplaybackRateMenuButton.menu.contentEl_.prepend(...$(`<li class="vjs-menu-title" tabindex="-1">Speed</li>`))

        this.is_mobile = !this.volumeBarMouseTimeDisplay;

        this.seektolive_wrapper_el = $(`<div>`)[0];
        this.seektolive_wrapper_el.classList.add("seek-to-live-wrapper");
        this.seekToLive.el_.after(this.seektolive_wrapper_el);
        this.seektolive_wrapper_el.append(this.seekToLive.el_);
        var seekToLive_handleClick = this.seekToLive.handleClick;
        this.seekToLive.handleClick = function(e) {
            seekToLive_handleClick.apply(this, [e]);
            this.player_.play();
        }
        
        if (conf.logo_url) {
            // let target = IS_EMBED ? `_parent` : `_blank`;
            let target = `_blank`;
            dom_utils.load_image("../logo").then(img=>{
                this.logo_el = $(`<a target="${target}" class="logo" href="${conf.logo_url}"></a>`)[0];
                this.logo_el.append(img);
                this.player.el_.append(this.logo_el);
            })
        }

        if (this.volumeBarMouseTimeDisplay) {
            this.volumeBarMouseTimeDisplay.update = this.volumeBarMouseTimeDisplay.__proto__.update;
            var volumeControl_handleMouseDown = this.volumeControl.handleMouseDown;
            this.volumeControl.handleMouseDown = function(event) {
                volumeControl_handleMouseDown.apply(this, [event]);
                this.volumeBar.handleMouseDown(event);
                pauseEvent(event);
            };
            this.volumeControl.handleMouseMove = function(e) {
                this.volumeBar.handleMouseMove(e);
                // fucking ridiculous...
                const progress = this.volumeBar.getProgress();
                this.volumeBar.bar.el().style.width = (progress * 100).toFixed(2) + '%';
            }
            this.volumeControl.throttledHandleMouseMove = function(e) {
                console.log(e.clientX, e.clientY)
                this.volumeControl.handleMouseMove.apply(this, [e]);
            };
        } else {
            // mobile
            this.volumeControl.el_.style.display = "none";
        }

        if (this.seekBarMouseTimeDisplay) {
            const timeTooltip = this.seekBarMouseTimeDisplay.getChild('timeTooltip');
            this.seekBarMouseTimeDisplay.update = function(seekBarRect, seekBarPoint) {
                const time = seekBarPoint * this.player_.duration();
                timeTooltip.updateTime(seekBarRect, seekBarPoint, time);
                this.el_.style.left = seekBarRect.width * seekBarPoint;
            };
            timeTooltip.update = function (seekBarRect, seekBarPoint, content) {
                this.write(content);
                _this.seekBarMouseTimeDisplay.el_.style.left = `${seekBarRect.width * seekBarPoint}px`;
                var w = this.el_.offsetWidth;
                var x = seekBarRect.width * seekBarPoint;
                var left = utils.clamp(x, w/2, window.innerWidth-w/2);
                var cx = Math.round(left - x - w/2);
                this.el_.style.transform = `translateX(${cx}px)`;
            };
            timeTooltip.updateTime = function(seekBarRect, seekBarPoint, time) {
                const liveWindow = _this.liveTracker.liveWindow();
                var time = seekBarPoint * liveWindow
                let content = _this.get_live_time(settings.get("time_display_mode"), time);
                this.update(seekBarRect, seekBarPoint, content);
            };
        }

        this.player.ready(()=>{
            if (autoplay) {
                new Promise((resolve,reject)=>{
                    this.player.play().then(resolve);
                    setTimeout(()=>reject("Autoplay was disallowed."), 2000);
                }).catch((e)=>console.error(e))
            }
        });
        this.player.on("error", console.error);
        this.player.on("pause",()=>this.update());
        this.player.on("seeking",()=>this.update());
        this.player.on("play",()=>{
            this.initialized = true;
            app.update()
        });
        this.player.on("ended",(e)=>this.update());
        this.liveTracker.on("liveedgechange", ()=>this.update());
        this.player.on("timeupdate", ()=>this.update());
        this.update_interval_id = setInterval(()=>this.update(), VIDEO_UI_UPDATE_INTERVAL);
    }

    get_time_until_live_edge_area(use_latency){
        const liveCurrentTime = utils.try(()=>this.liveTracker.liveCurrentTime(), 0);
        const currentTime = this.player.currentTime();
        return Math.max(0, Math.abs(liveCurrentTime - currentTime) - (use_latency ? this.hls.targetLatency/2 : 0));
    };

    get_live_time(mode, time){
        const duration = this.player.duration();
        if (this.liveTracker && this.liveTracker.isLive()) {
            const liveWindow = this.liveTracker.liveWindow();
            const secondsBehind = liveWindow - time;
            if (mode == 0) {
                return new Date(Date.now()-secondsBehind*1000).toLocaleTimeString('en-GB', {hour: '2-digit', minute:'2-digit', second: "2-digit"}) // hour12: true
            } else if (mode == 1) {
                return (secondsBehind < 1 ? '' : '-') + videojs.time.formatTime(secondsBehind, liveWindow);
            }
        } else {
            return videojs.time.formatTime(time, duration);
        }
    }

    destroy() {
        var player = this.player;
        this.player = null;
        if (player) player.dispose();
        if (this.hls) this.hls.destroy();
        this.hls = null;
        this.crop_detect_canvas = null;
        clearInterval(this.update_interval_id);
        clearInterval(this.update_ar_interval_id);
        app.player = null;
        app.update();
    }
}

class CropDetect {
    /** @type {HTMLVideoElement} */
    video_el;
    /** @type {HTMLCanvasElement} */
    canvas;
    /** @type {Crop[]} */
    possible_crops;
    /** @type {Crop[]} */
    regions = [];
    get vw() { return this.video_el.videoWidth; }
    get vh() { return this.video_el.videoHeight; }

    constructor(video_el) {
        this.video_el = video_el;
        this.ready = this.init();
    }

    async init() {
        this.canvas = this.crop_detect_canvas = document.createElement('canvas');

        await new Promise(resolve=>{
            this.video_el.addEventListener("loadeddata", resolve)
            if (this.video_el.readyState >= HTMLMediaElement.HAVE_METADATA) resolve();
        });
        this.interval_id = setInterval(()=>this.update(), CROP_DETECT_INTERVAL);

        var {vw,vh} = this;
        var ar = vw / vh;
        ar = utils.nearest(ar, (4/3), (16/9));

        // if source is 16/9
        var crops;
        if (ar == (16/9)) {
            crops = [
                [vw, vh],
                [vh*(4/3), vh],
                [vh*(4/3), (vh*(4/3))/(16/9)],
            ]
        } else {
            crops = [
                [vw, vh],
                [vw, vw/(16/9)],
                [(vw/(16/9))*(4/3), vw/(16/9)],
            ]
        }
        this.region = new Crop(vw, vh);
        this.possible_crops = crops.map(([w,h])=>Crop.from(w,h,vw,vh));
        this.canvas.height = 120;
        this.canvas.width = this.canvas.height * ar;
        this.update();
        return true;
    }
    
    async update() {
        let {vw,vh} = this;
        // if (this.video_el.paused || this.video_el.ended) return;
        if (this._last_time == this.video_el.currentTime) return;
        this._last_time = this.video_el.currentTime;
        var s = vh / this.canvas.height;
        let ctx = this.canvas.getContext('2d');
        let x0=0, y0=0, ow=this.canvas.width, oh=this.canvas.height;
        let x1=ow, y1=oh;
        let tx, ty;
        let threshold = 0x11;
        ctx.filter = "grayscale(100%) contrast(1.05)";
        ctx.drawImage(this.video_el, 0, 0, x1, y1);
        ctx.filter = "none";
        let data = ctx.getImageData(0,0, x1, y1).data;
        var row = (y)=>{
            for (tx=x0; tx<x1; tx++) if (data[(y*ow+tx)*4]>threshold) return true;
        };
        var col = (x)=>{
            for (ty=y0; ty<y1; ty++) if (data[(ty*ow+x)*4]>threshold) return true;
        };

        for (;y0<y1;y0++) if (row(y0+1)) break;
        for (;x0<x1;x0++) if (col(x0+1)) break;
        for (;y1>=0;y1--) if (row(y1-1)) break;
        for (;x1>=0;x1--) if (col(x1-1)) break;

        x0*=s; x1*=s; y0*=s; y1*=s;
        var r = new Crop({x0,y0,x1,y1});
        if (!r.valid) return;

        /** @param {Crop} r */
        var draw_crop = (r, color="red")=>{
            let {x0,x1,y0,y1,w,h} = r;
            ctx.strokeStyle = color;
            ctx.strokeRect(x0/s, y0/s, w/s, h/s);
        }

        if (DEBUG) draw_crop(r, "green");

        if (r.w < vw/2 || r.h < vh/2) return;

        this.push_region(r);

        this.region_nearest = [...this.possible_crops].sort((a,b)=>{
            return a.difference(this.region) - b.difference(this.region);
        })[0];

        if (DEBUG) {
            if (!this.canvas.parentElement) {
                Object.assign(this.canvas.style, {"position":"absolute", "top":"0","right":"0", "pointer-events":"none", "border":"1px solid blue"});
                document.body.append(this.canvas);
            }
            draw_crop(this.region_nearest, "red");
        }

        this.apply();
    }
    /** @param {Region} r */
    push_region(r) {
        this.regions.push(r);
        while (this.regions.length > REGION_BUFFER) this.regions.shift();
        if (this.regions.length < MIN_REGIONS_FIRST_CROP) return;

        let x0=0,x1=0,y0=0,y1=0;
        for (var r of this.regions) {
            x0+=r.x0; x1+=r.x1; y0+=r.y0; y1+=r.y1;
        }
        x0 /= this.regions.length;
        x1 /= this.regions.length;
        y0 /= this.regions.length;
        y1 /= this.regions.length;
        this.region = new Crop({x0,x1,y0,y1});
    }
    apply() {
        var {vw,vh} = this;
        var c = this.region_nearest;
        if (!c.valid) return;
        if (c.w < vw/2 || c.h < vh/2) return;
        var ww = window.innerWidth;
        var wh = window.innerHeight;
        var scale = Math.min(ww/c.w, wh/c.h);
        Object.assign(this.video_el.style, {
            "width": `${vw}px`,
            "height": `${vh}px`,
            "transform-origin": `${c.x0}px ${c.y0}px`,
            "transform": `translate(${-c.x0}px, ${-c.y0}px) scale(${scale})`,
            "left": `${(ww/2)-(c.w/2*scale)}px`,
            "top": `${(wh/2)-(c.h/2*scale)}px`,
        });
    }
    dispose() {
        this.canvas.remove();
        clearInterval(this.interval_id);
        this.video_el.style = {};
        /* Object.assign(this.video_el.style, {
            "width": ``,
            "height": ``,
            "transform-origin": ``,
            "transform": ``,
            "left": ``,
            "top": ``,
        }) */
    }
}

class Crop {
    x0 = 0;
    x1 = 0;
    y0 = 0;
    y1 = 0;
    get w() { return this.x1 - this.x0; }
    get h() { return this.y1 - this.y0; }
    get area() { return this.w * this.h; }
    get valid() { return this.area > 0; }
    constructor({x0,x1,y0,y1}) {
        if (arguments.length == 2) {
            var [w,h] = [...arguments];
            this.x1 = w;
            this.y1 = h;
        } else {
            this.x0 = x0;
            this.x1 = x1;
            this.y0 = y0;
            this.y1 = y1;
        }
    }
    /** @param {Crop} b */
    difference(b) {
        var a = this;
        return Math.abs(b.x0-a.x0) + Math.abs(b.y0-a.y0) + Math.abs(b.x1-a.x1) + Math.abs(b.y1-a.y1);
    }
    static from(w,h,vw,vh) {
        return new Crop({x0:(vw-w)/2, x1:vw-(vw-w)/2, y0:(vh-h)/2, y1:vh-(vh-h)/2});
    }
}

export const app = new App();
app.init();