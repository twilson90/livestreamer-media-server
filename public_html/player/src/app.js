import { dom_utils, utils, $, Hls, videojs } from "./core.js";
import './app.scss';

(async()=>{
  // var conf = await fetch("conf").then(c=>c.json());
  var params = new URLSearchParams(window.location.search);
  var src = new URL(`../media/live/${params.get("id")}/master.m3u8`, window.location.origin+window.location.pathname).toString();
  console.log(src);
  /** @type {HTMLVideoElement} */
  var video_el;
  /** @type {import("video.js/dist/types/player").default}*/
  var player;
  /** @type {import("hls.js").default>}*/
  var hls;
  var initialized = false;
  var update_interval;
  var time_display_mode = +localStorage.getItem("time_display_mode") || 0;
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

  var play_button = $(
`<div class="play-button">
  <div class="play"><i class="fas fa-play"></i></div>
  <div class="pause"><i class="fas fa-pause"></i></div>
  <div class="ended"><div style="padding:10px">The stream has ended.</div><i class="fas fa-redo"></i></div>
</div>`
  )[0];
  play_button.onclick = (e)=>{
    if (player) player.play();
    else init(e, true);
  }

  var showing_play_overlay = false;
  var update_play_button = (e)=>{
    var seeking  = player ? player.scrubbing() || player.seeking() : false;
    var videoWasPlaying = player ? player.controlBar.progressControl.seekBar.videoWasPlaying : null;
    // console.log(e && e.type, seeking, videoWasPlaying);
    var ended = player ? player.ended() : false;
    var paused = player ? player.hasStarted() && player.paused() && (!seeking || !videoWasPlaying) : false;
    var status = ended ? "ended" : paused ? "paused" : ""
    var show = !player || !initialized || !!status;
    play_button.querySelector(".play").style.display = status == "" ? "" :  "none";
    play_button.querySelector(".pause").style.display = status == "paused" ? "" : "none";
    play_button.querySelector(".ended").style.display = status == "ended" ? "" : "none";
    if (player && play_button.parentElement != player.el_) player.el_.querySelector("video").after(play_button);
    else if (!player && play_button.parentElement != document.body) document.body.append(play_button);
    if (show != showing_play_overlay) {
      play_button.style.pointerEvents = show ? "" : "none";
      // play_button.style.display = show ? "": "none";
      if (show) $(play_button).fadeIn(200);
      else $(play_button).fadeOut(200);
    }
    
    
    // console.log(e, videoWasPlaying);
    showing_play_overlay = show;
  }

  var uninit = ()=>{
    if (player) player.dispose();
    if (hls) hls.destroy();
    player = null;
    hls = null;
    clearInterval(update_interval);
    update_play_button();
  }

  var init = (event, play)=>{
    uninit();
    video_el = $(`<video class="video-js" preload="auto" width="1280" height="720"></video>`)[0];
    document.body.append(video_el);
    video_el.addEventListener("error", (e)=>{
      console.log(e);
    });

    if (Hls.isSupported()) {
  
      var Button = videojs.getComponent("Button");
      var MenuButton = videojs.getComponent("MenuButton");
      var MenuItem = videojs.getComponent("MenuItem");
      var ProgressControl = videojs.getComponent("ProgressControl");
      var VolumeControl = videojs.getComponent("VolumeControl");
      var MouseTimeDisplay = videojs.getComponent("MouseTimeDisplay");
      var PlaybackRateMenuButton = videojs.getComponent("PlaybackRateMenuButton");
      var PlaybackRateMenuItem = videojs.getComponent("PlaybackRateMenuItem");

      // var PlaybackRateMenuButton_createItems = PlaybackRateMenuButton.prototype.createItems
      // PlaybackRateMenuButton.prototype.createItems = function(...args) {
      //   var items = PlaybackRateMenuButton_createItems.apply(this, args);
      //   var last = items.find(i=>i.rate == -1);
      //   if (last) {
      //     last.label = "AUTO";
      //     last.el_.querySelector(".vjs-menu-item-text").innerText = "AUTO";
      //   }
      //   return items;
      // }

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
          uninit()
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
            // title: "Quality",
            className: "", 
            ...options,
          });
          var update_label = (level)=>{
            var data = levels.find(l=>l.value == level);
            this.q_label.innerHTML = data ? data.text : "-";
          }
          var levels = [];
          hls.on(Hls.Events.MANIFEST_PARSED, (event, data)=>{
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
          hls.on(Hls.Events.LEVEL_SWITCHING, (event, data)=>{
            update_label(data.level);
          });
          hls.on(Hls.Events.LEVEL_UPDATED, (event, data)=>{
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
            var level = get_preferred_level();
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
              hls.nextLevel = level.value;
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
          this.time_icon = document.createElement("div");
          this.el_.prepend(this.time_icon);
          this.update();
        }
        handleClick(event) {
          time_display_mode = (time_display_mode+1) % time_display_modes.length;
          localStorage.setItem("time_display_mode", time_display_mode)
          this.update();
        }
        update() {
          // console.log("time_display_mode", time_display_mode)
          var c = time_display_modes[time_display_mode];
          this.time_icon.innerHTML = c.icon
          this.controlText(`Time Display Mode: ${c.label}`);
        }
        buildCSSClass() {
          return `vjs-time-display-toggle vjs-control vjs-button ${super.buildCSSClass()}`;
        }
      }
      videojs.registerComponent("timeDisplayToggle", TimeDisplayToggle);

      hls = new Hls({
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
      
      hls.on(Hls.Events.MANIFEST_PARSED, (event, data)=>{
        var level = get_preferred_level();
        if (level >= 0) hls.nextLevel = level;
      });

      player = videojs(video_el, {
        // autoplay: true,
        // muted: true, 
        // volume:0,
        // fluid: true,
        playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2], // , -1
        controls: true,
        responsive: true,
        liveui: true,
        enableSmoothSeeking: true,
        
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

      player.on("pause",(e)=>update_play_button(e));
      player.on("seeking",(e)=>update_play_button(e));
      player.on("play",(e)=>{
        initialized = true;
        update_play_button(e)
      });
      player.on("ended",(e)=>update_play_button(e));
      // player.on("seeked",(e)=>update_play_button(e));
      // seekBarPlayProgressBar.__proto__.update.apply(seekBarPlayProgressBar);

      var player_playbackRate = player.playbackRate;
      var auto_playback_rate = true;

      player.playbackRate = function(rate){
        if (rate === undefined) {
          if (auto_playback_rate) return -1;
          return player_playbackRate.apply(this);
        } else {
          auto_playback_rate = rate === -1;
          if (rate !== -1) return player_playbackRate.apply(this, [rate]);
        }
      }

      hls.loadSource(src);
      hls.attachMedia(video_el);

      // hls.media.srcObject.setLiveSeekableRange(0, 600)
      // hls.on(Hls.Events.ERROR, (...e)=>{
      //   console.error(e);
      // })

      player.on('volumechange', function() {
        localStorage.setItem('volume', player.muted() ? 0 : player.volume());
      });
      if (localStorage.getItem("volume") !== undefined) {
        player.volume(+localStorage.getItem("volume"));
      }

      /** @type {import("video.js/dist/types/control-bar/control-bar").default}*/
      var controlBar = player.controlBar;
      /** @type {import("video.js/dist/types/control-bar/seek-to-live").default}*/
      var seekToLive = controlBar.getChild("SeekToLive");
      /** @type {import("video.js/dist/types/control-bar/volume-panel").default}*/
      var volumePanel = controlBar.getChild("VolumePanel");
      /** @type {import("video.js/dist/types/control-bar/volume-control/volume-control").default}*/
      var volumeControl = volumePanel.getChild("VolumeControl");
      /** @type {import("video.js/dist/types/control-bar/volume-control/volume-bar").default}*/
      var volumeBar = volumeControl.getChild("VolumeBar");
      /** @type {TimeDisplayToggle} */
      var timeDisplayToggle = controlBar.getChild("TimeDisplayToggle");
      /** @type {import("video.js/dist/types/control-bar/volume-control/mouse-volume-level-display").default}*/
      const volumeBarMouseTimeDisplay = volumeBar.getChild('MouseVolumeLevelDisplay');
      /** @type {import("video.js/dist/types/control-bar/progress-control/progress-control").default}*/
      const progressControl = controlBar.getChild('progressControl');
      /** @type {import("video.js/dist/types/control-bar/progress-control/seek-bar").default}*/
      const seekBar = progressControl.getChild('seekBar');
      /** @type {import("video.js/dist/types/control-bar/progress-control/mouse-time-display").default}*/
      const seekBarMouseTimeDisplay = seekBar.getChild('mouseTimeDisplay');
      /** @type {import("video.js/dist/types/control-bar/progress-control/play-progress-bar").default}*/
      const seekBarPlayProgressBar = seekBar.getChild('playProgressBar');
      /** @type {import("video.js/dist/types/control-bar/playback-rate-menu/playback-rate-menu-button").default}*/
      const controlplaybackRateMenuButton = controlBar.getChild('playbackRateMenuButton');

      var is_mobile = !volumeBarMouseTimeDisplay;

      var seektolive_wrapper_el = $(`<div>`)[0];
      seektolive_wrapper_el.classList.add("seek-to-live-wrapper");
      seekToLive.el_.after(seektolive_wrapper_el);
      seektolive_wrapper_el.append(seekToLive.el_);
      var seekToLive_handleClick = seekToLive.handleClick;
      seekToLive.handleClick = function(e) {
        seekToLive_handleClick.apply(this, [e]);
        player.play();
      }
      
      var logo = $(`<a class="logo" href="https://cabtv.co.uk"><img src="logo.svg"></a>`)[0]
      player.el_.append(logo);

      if (volumeBarMouseTimeDisplay) {
        volumeBarMouseTimeDisplay.update = volumeBarMouseTimeDisplay.__proto__.update;
        var volumeControl_handleMouseDown = volumeControl.handleMouseDown;
        volumeControl.handleMouseDown = function(event) {
          volumeControl_handleMouseDown.apply(this, [event]);
          volumeBar.handleMouseDown(event);
          pauseEvent(event);
        };
        volumeControl.handleMouseMove = function(e) {
          this.volumeBar.handleMouseMove(e);
          // fucking ridiculous...
          const progress = this.volumeBar.getProgress();
          this.volumeBar.bar.el().style.width = (progress * 100).toFixed(2) + '%';
        }
        volumeControl.throttledHandleMouseMove = function(e) {
          console.log(e.clientX, e.clientY)
          volumeControl.handleMouseMove.apply(this, [e]);
        };
      } else {
        // mobile
        volumeControl.el_.style.display = "none";
      }

      if (seekBarMouseTimeDisplay) {
        const timeTooltip = seekBarMouseTimeDisplay.getChild('timeTooltip');
        seekBarMouseTimeDisplay.update = function(seekBarRect, seekBarPoint) {
          const time = seekBarPoint * this.player_.duration();
          timeTooltip.updateTime(seekBarRect, seekBarPoint, time);
          this.el_.style.left = seekBarRect.width * seekBarPoint;
        };
        timeTooltip.update = function (seekBarRect, seekBarPoint, content) {
          this.write(content);
          seekBarMouseTimeDisplay.el_.style.left = `${seekBarRect.width * seekBarPoint}px`;
          var w = this.el_.offsetWidth;
          var x = seekBarRect.width * seekBarPoint;
          var left = utils.clamp(x, w/2, window.innerWidth-w/2);
          var cx = Math.round(left - x - w/2);
          this.el_.style.transform = `translateX(${cx}px)`;
        };
        timeTooltip.updateTime = function(seekBarRect, seekBarPoint, time) {
          const liveWindow = liveTracker.liveWindow();
          var time = seekBarPoint * liveWindow
          let content = get_live_time(time_display_mode, time);
          this.update(seekBarRect, seekBarPoint, content);
        };
      }

      var get_live_time = (mode, time)=>{
        const duration = player.duration();
        if (liveTracker && liveTracker.isLive()) {
          const liveWindow = liveTracker.liveWindow();
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
      
      /** @type {import("video.js/dist/types/live-tracker").default}*/
      var liveTracker = player.liveTracker;
      var get_time_until_live_edge_area = (use_latency)=>{
        const liveCurrentTime = utils.try(()=>liveTracker.liveCurrentTime(), 0);
        const currentTime = player.currentTime();
        return Math.max(0, Math.abs(liveCurrentTime - currentTime) - (use_latency ? hls.targetLatency/2 : 0));
      };
      var update = ()=>{
        // liveTracker.options_.liveTolerance = hls.targetLatency ? (hls.targetLatency) : liveTracker.options_.liveTolerance; // good to have a bit of extra buffer
        
        var d = get_time_until_live_edge_area(true);
        var behindLiveEdge = liveTracker.behindLiveEdge();
        
        var rate = player.playbackRate();
        var new_rate;
        var at_live_edge = d <= 0 && !behindLiveEdge;
        // if (rate === -1) {
        //   new_rate = at_live_edge ? 1.0 : 1.5;
        // } else {
        new_rate = at_live_edge ? Math.min(1, rate) : rate;
        // }
        if (new_rate != rate) {
          player.playbackRate(new_rate);
        }

        // console.log("liveTracker.behindLiveEdge()", liveTracker.behindLiveEdge())
        var stl_text;
        if (liveTracker.behindLiveEdge()) {
          if (is_mobile && time_display_mode == 0) {
            stl_text = "["+get_live_time(0, player.currentTime())+"]"
          } else {
            stl_text = `[-${videojs.time.formatTime(get_time_until_live_edge_area())}]`
          }
        } else {
          stl_text = "LIVE"
        }
        if (seekToLive.last_text != stl_text) {
          seekToLive.last_text = stl_text
          seekToLive.textEl_.innerHTML = stl_text;
        }
        
        var is_live = liveTracker.isLive();
        if (is_live) timeDisplayToggle.show();
        else timeDisplayToggle.hide();
      }
      liveTracker.on("liveedgechange", update);
      update_interval = setInterval(update, 100);
      player.on("timeupdate", update);

      player.ready(()=>{
        if (play) {
          new Promise((resolve,reject)=>{
            player.play().then(resolve);
            setTimeout(()=>reject("Autoplay was disallowed."), 2000);
          }).catch((e)=>console.error(e))
        }
      });
      player.on("error", console.error);
    } else if (video_el.canPlayType('application/vnd.apple.mpegurl')) {
      video_el.src = src;
    }
    update_play_button();
  }

  var params = new URLSearchParams(location.search);
  init(null, params.get("autoplay") == "1");

  var messenger = new dom_utils.WindowCommunicator();
  messenger.on("set_scale", (s)=>{
    s = s || 1;
    video_el.style.transform = `scale(${s})`;
    return true;
  });

  // player.qualityLevels();
  // player.qualitySelectorHls();
  /* var old_seekToLiveEdge = player.liveTracker.seekToLiveEdge;
  player.liveTracker.seekToLiveEdge = function(...args){
    var ret = old_seekToLiveEdge.apply(this, args);
    player.play();
    return ret;
  } */
  /* player.ready(()=>{
    player.liveTracker.seekToLiveEdge();
  }) */

  function get_preferred_level() {
    var level = localStorage.getItem("level");
    if (level == null) level = -1;
    return +level;
  }
})();