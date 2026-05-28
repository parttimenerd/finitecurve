import React from 'react';
import Button from '@material-ui/core/Button';
import Checkbox from "@material-ui/core/Checkbox";
import Divider from "@material-ui/core/Divider";
import Drawer from "@material-ui/core/Drawer";
import FormControlLabel from "@material-ui/core/FormControlLabel";
import Grid from "@material-ui/core/Grid";
import { makeStyles } from '@material-ui/core/styles';
import { withStyles } from '@material-ui/core/styles';
import Slider from "@material-ui/core/Slider";
import Tooltip from "@material-ui/core/Tooltip";
import Typography from "@material-ui/core/Typography";
import CircularProgress from '@material-ui/core/CircularProgress';

import { MapInteractionCSS } from 'react-map-interaction';
import { ColorPicker } from 'material-ui-color';

import List from "@material-ui/core/List";
import ListItem from "@material-ui/core/ListItem";

import exPig from './examples/pig.jpg';
import exDog from './examples/dog.jpg';
import exWorld from './examples/world.png';

import OneLineClient from './OneLineClient.js';
import { separateColors } from './colorSeparate.js';

import './App.css';
window.React = React;

const drawerWidth = 220;

const styles = {
  root: {
    display: 'flex',
    height: '100%',
  },
  drawer: {
    width: drawerWidth,
    flexShrink: 0,
  },
  drawerPaper: {
    width: drawerWidth,
    "overflow-x": "hidden",
  },
  content: {
    flexGrow: 1,
    position: "relative",
    overflow: "hidden",
    top: 0,
    bottom: 0,
    left: 0,
    right: 0,
  },
  lowButton: {
    width: drawerWidth - 40,
    marginLeft: 20,
    marginRight: 20,
    marginTop: 20,
    marginBottom: 0,
  },
  highButton: {
    width: drawerWidth - 40,
    marginLeft: 20,
    marginRight: 20,
    marginTop: 0,
    marginBottom: 20,
  },
  lowHighButton: {
    width: drawerWidth - 40,
    marginLeft: 20,
    marginRight: 20,
    marginTop: 20,
    marginBottom: 20,
  },
  imageSelector: {
    display: "inline-block",
    padding: "25px",
    border: "solid 4px #aaa",
    "border-radius": "25px",
    backgroundColor: "#fff",
  },
  errorBox: {
    display: "inline-block",
    padding: "25px",
    border: "solid 4px #f00",
    "border-radius": "25px",
    backgroundColor: "#fff",
  },
  exampleBox: {
    width: "80px",
    height: "80px",
  },
  toast: {
    position: "absolute",
    top: "0.5em",
    left: "0.5em",
  },
  stats: {
    position: "absolute",
    bottom: "0.5em",
    left: "0.5em",
    fontSize: 12,
    color: "gray",
  },
};

const madeStyles = makeStyles(styles);

// ─── Palette utilities ────────────────────────────────────────────────────────

function rgbToHSL(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}

function rgbToHex(r, g, b) {
  return '#' + [r, g, b].map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
}

async function decodeImageRGBA(arrayBuffer) {
  const blob = new Blob([arrayBuffer]);
  let bitmap;
  try {
    bitmap = await createImageBitmap(blob);
  } catch (e) {
    return null;
  }
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0);
  const imageData = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  return { rgbaData: imageData.data, width: bitmap.width, height: bitmap.height };
}

async function suggestPalette(arrayBuffer, n) {
  const decoded = await decodeImageRGBA(arrayBuffer);
  if (!decoded) return null;
  const { rgbaData, width, height } = decoded;

  const samples = [];
  const stride = 8; // sample every 8th pixel
  for (let i = 0; i < width * height; i += stride) {
    const a = rgbaData[i * 4 + 3];
    if (a < 128) continue;
    samples.push([rgbaData[i * 4], rgbaData[i * 4 + 1], rgbaData[i * 4 + 2]]);
  }
  if (samples.length === 0) return null;

  // Initialise centroids spread evenly over luminance-sorted samples
  const sorted = [...samples].sort(
    (a, b) => (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2]) - (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2])
  );
  let centroids = Array.from({ length: n }, (_, i) =>
    [...sorted[Math.floor(i * sorted.length / n)]]
  );

  for (let iter = 0; iter < 8; iter++) {
    const sums = Array.from({ length: n }, () => [0, 0, 0, 0]);
    for (const [r, g, b] of samples) {
      let best = 0, bestDist = Infinity;
      for (let k = 0; k < n; k++) {
        const dr = r - centroids[k][0], dg = g - centroids[k][1], db = b - centroids[k][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestDist) { bestDist = d; best = k; }
      }
      sums[best][0] += r; sums[best][1] += g; sums[best][2] += b; sums[best][3]++;
    }
    const prev = centroids;
    centroids = sums.map(([r, g, b, c], i) =>
      c > 0 ? [r / c, g / c, b / c] : prev[i]
    );
  }

  // Sort by hue for a rainbow-ish ordering
  centroids.sort((a, b) => rgbToHSL(...a)[0] - rgbToHSL(...b)[0]);
  return centroids.map(([r, g, b]) => ({ hex: rgbToHex(r, g, b) }));
}

// ─── State ────────────────────────────────────────────────────────────────────

const uiState = {
  SELECTING: 1,
  PROCESSING: 2,
  PENDING: 3,
  VIEWING: 4,
  ERROR: 5,
};

const DEFAULT_COLORS = [
  { hex: '#1a1a2e' },
  { hex: '#16213e' },
  { hex: '#0f3460' },
  { hex: '#e94560' },
  { hex: '#f5a623' },
  { hex: '#d4d4d4' },
];

// ─── App ──────────────────────────────────────────────────────────────────────

class App extends React.Component {
  constructor(props) {
    super(props);
    this._lastDecodedImage = null;
    this._lastImageBuffer = null;
    this.state = {
      lastDraw: 0,
      url: "data:",
      background: "white",
      width: 0,
      height: 0,
      ui: uiState.SELECTING,
      status: "",
      map: { scale: 1, translation: { x: 0, y: 0 } },
      controls: this.getDefaultControls(),
    };
    OneLineClient.onResult = d => this.processResult(this, d);
  }

  componentDidMount() {
    this.setImageUrl(process.env.PUBLIC_URL + "/splash.jpg", 1920, 1117);
  }

  getDefaultControls() {
    return {
      timestamp: Date.now(),
      resolution: 30,
      lineWidth: 4,
      contrast: 50,
      whiteCutoff: 240,
      invert: false,
      colors: DEFAULT_COLORS.map(c => ({ ...c })),
      bg: "white",
    };
  }

  openFeedback() {
    window.location.href = "https://www.facebook.com/finitecurve";
  }

  getUiStateElement() {
    switch (this.state.ui) {
      case uiState.SELECTING:
        return (
          <ImageSelector
            onImageLoading={e => this.onImageLoading(e)}
            onImageSelected={e => this.onImageSelected(e)}
          />);
      case uiState.PROCESSING:
        return <Spinner>Rendering...</Spinner>;
      case uiState.PENDING:
        return <Spinner>Finishing previous...</Spinner>;
      case uiState.ERROR:
        return (
          <ErrorMessage onAccept={() => this.openImageSelection()}>
            {this.state.error}
          </ErrorMessage>
        );
      case uiState.VIEWING:
        return <span />;
      default:
        alert("Developer messed up: " + this.state.ui);
    }
  }

  onImageLoading(event) {
    this.setStatus("Loading...");
  }

  onImageSelected(event) {
    this._lastImageBuffer = event.data;
    this.setStatus("Processing...");

    decodeImageRGBA(event.data).then(decoded => {
      this._lastDecodedImage = decoded;
      const n = this.state.controls.colors.length;
      return suggestPalette(event.data, n).then(palette => {
        if (palette) {
          this.setState(
            prev => ({ controls: { ...prev.controls, colors: palette } }),
            () => this.startBuild()
          );
        } else {
          this.startBuild();
        }
      });
    });
  }

  triggerBuild(lastTime) {
    if (lastTime < this.state.controls.timestamp) return;
    this.startBuild();
  }

  startBuild() {
    switch (this.state.ui) {
      case uiState.PROCESSING:
      case uiState.PENDING:
        this.setState({ ui: uiState.PENDING });
        break;
      case uiState.VIEWING:
      case uiState.SELECTING:
        this.setState({ ui: uiState.PROCESSING }, () => {
          if (!this._lastDecodedImage) return;
          const { colors, ...commonOptions } = this.state.controls;
          const { rgbaData, width, height } = this._lastDecodedImage;
          const channels = separateColors(rgbaData, width, height, colors);
          const threads = colors.map((c, i) => ({
            hex: this.toHexColor(c.hex),
            grayscaleChannel: channels[i],
            width,
            height,
          }));
          OneLineClient.buildMulti(threads, commonOptions);
        });
        break;
      default:
        break;
    }
  }

  setStatus(string) {
    this.setState({ status: string });
  }

  changeControls(c) {
    const time = Date.now();
    const next = { ...this.state.controls, ...c, timestamp: time };
    this.setState({ controls: next });
    if (this.state.ui !== uiState.SELECTING) {
      setTimeout(() => this.triggerBuild(time), 1000);
    }
  }

  openImageSelection() {
    this.setState({ ui: uiState.SELECTING });
  }

  autoSuggestPalette() {
    if (!this._lastImageBuffer) return;
    const n = this.state.controls.colors.length;
    suggestPalette(this._lastImageBuffer, n).then(palette => {
      if (palette) this.changeControls({ colors: palette });
    });
  }

  downloadFile(name, url) {
    const element = document.createElement("a");
    element.setAttribute("href", url);
    element.setAttribute("download", name);
    document.body.appendChild(element);
    element.click();
    document.body.removeChild(element);
  }

  getPngUrl() {
    const canvas = document.createElement("canvas");
    const img = document.createElement("img");
    img.src = this.state.url;
    canvas.width = img.width = this.state.width;
    canvas.height = img.height = this.state.height;
    document.body.appendChild(canvas);
    document.body.appendChild(img);
    const ctx = canvas.getContext("2d");
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = this.toHexColor(this.state.controls.bg);
    ctx.fill();
    ctx.drawImage(img, 0, 0);
    const url = canvas.toDataURL('image/png');
    document.body.removeChild(img);
    document.body.removeChild(canvas);
    return url;
  }

  toHexColor(c) {
    if (typeof c === "string") return c;
    return "#" + c.hex;
  }

  render() {
    const { classes } = this.props;
    return (
      <div className={classes.root}>
        <AppDrawer
          {...this.state.controls}
          onChange={c => this.changeControls(c)}
          onNewImage={() => this.openImageSelection()}
          onDownloadSVG={() => this.downloadFile("finitecurve.svg", this.state.url)}
          onDownloadPNG={() => this.downloadFile("finitecurve.png", this.getPngUrl())}
          onResetParams={() => this.changeControls(this.getDefaultControls())}
          onFeedback={() => this.openFeedback()}
          onAutoSuggest={() => this.autoSuggestPalette()}
          canSelect={this.state.ui !== uiState.SELECTING}
          canDownload={this.state.ui === uiState.VIEWING}
        />
        <div className={classes.content} id="content" style={{ backgroundColor: this.state.background }}>
          <Typography className={classes.toast}>{this.getToastMessage()}</Typography>
          <Typography className={classes.stats}>{this.getStats()}</Typography>
          {this.getUiStateElement(this.state.ui)}
          <MapInteractionCSS value={this.state.map} onChange={(c) => this.setState({ map: c })}>
            <img src={this.state.url} width={this.state.width + "px"} height={this.state.height + "px"} alt="" />
          </MapInteractionCSS>
        </div>
      </div>
    );
  }

  getToastMessage() {
    if (this.state.ui !== uiState.VIEWING) return "";
    if (this.state.map.translation.x === 0 && this.state.map.translation.y === 0) {
      return "Pan/zoom to view details!";
    }
    return "";
  }

  getStats() {
    if (this.state.ui !== uiState.VIEWING) return "";
    const dist = typeof (this.state.lineLength) === "number" ? this.state.lineLength.toFixed(0) : "?";
    return "Image: " + this.state.width + "x" + this.state.height + "px. Line: " + dist + "px";
  }

  processResult(self, data) {
    if (data.success) {
      const isPartial = data.type === 'partial';
      const url = "data:image/svg+xml;charset=utf-8;base64," + btoa(data.result);
      this.setImageUrl(url, data.width, data.height, {
        lineLength: data.lineLength,
        background: this.toHexColor(this.state.controls.bg),
      }, isPartial);
    } else {
      this.setState({ ui: uiState.ERROR, error: data.error });
    }
  }

  setImageUrl(url, width, height, other, isPartial) {
    const content = document.getElementById("content");
    const scale = Math.min(
      content.clientWidth / width,
      content.clientHeight / height);
    this.setState({
      url, width, height,
      map: { scale, translation: { x: 0, y: 0 } },
      ...other,
    });
    this.setStatus("");

    switch (this.state.ui) {
      case uiState.PROCESSING:
        this.setState({ ui: uiState.VIEWING });
        break;
      case uiState.PENDING:
        if (!isPartial) this.setState({ ui: uiState.VIEWING }, () => this.startBuild());
        break;
      case uiState.VIEWING:
        break;
      default:
        break;
    }
  }
}

// ─── Utilities ────────────────────────────────────────────────────────────────

function removeKey(old) {
  const x = { ...old };
  for (let i = 1; i < arguments.length; i++) delete x[arguments[i]];
  return x;
}

// ─── Components ───────────────────────────────────────────────────────────────

function ParameterSlider(props) {
  return (
    <Grid container direction="column" spacing={0}>
      <Grid item>
        <Tooltip title={props.tooltip} arrow>
          <Typography>{props.title}</Typography>
        </Tooltip>
      </Grid>
      <Grid item>
        <Tooltip title={props.tooltip} arrow>
          <Slider
            min={props.min}
            max={props.max}
            value={props.value}
            onChange={(c, newValue) => props.onChange(newValue)}
            aria-labelledby="continuous-slider"
            valueLabelDisplay="auto"
            {...removeKey(props, "title")}
          />
        </Tooltip>
      </Grid>
    </Grid>
  );
}

function ParameterCheckbox(props) {
  return (
    <Grid container direction="column" spacing={0}>
      <Grid item>
        <Tooltip title={props.tooltip} arrow>
          <FormControlLabel control={
            <Checkbox
              color="primary"
              checked={props.value}
              onChange={(c, newValue) => props.onChange(newValue)}
              aria-labelledby="continuous-slider"
              valueLabelDisplay="auto"
              {...removeKey(props, "title")}
            />}
            label={props.title} />
        </Tooltip>
      </Grid>
    </Grid>
  );
}

function ColorPaletteEditor({ colors, onChange, onAutoSuggest }) {
  const MAX_COLORS = 12;
  const MIN_COLORS = 1;

  function addColor() {
    if (colors.length >= MAX_COLORS) return;
    onChange([...colors, { hex: '#888888' }]);
  }

  function removeColor(index) {
    if (colors.length <= MIN_COLORS) return;
    onChange(colors.filter((_, i) => i !== index));
  }

  function updateColor(index, value) {
    const hex = typeof value === 'string' ? value : '#' + value.hex;
    onChange(colors.map((c, i) => i === index ? { ...c, hex } : c));
  }

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 2 }}>
        {colors.map((c, i) => (
          <div key={i} style={{ position: 'relative', display: 'inline-flex' }}>
            <ColorPicker
              value={c.hex}
              hideTextfield
              disableAlpha
              onChange={v => updateColor(i, v)}
            />
            {colors.length > MIN_COLORS && (
              <span
                onClick={() => removeColor(i)}
                style={{
                  position: 'absolute', top: -4, right: -4, cursor: 'pointer',
                  background: '#fff', borderRadius: '50%', fontSize: 9,
                  lineHeight: '13px', width: 13, textAlign: 'center',
                  border: '1px solid #aaa', zIndex: 1, userSelect: 'none',
                }}
              >x</span>
            )}
          </div>
        ))}
        {colors.length < MAX_COLORS && (
          <Button onClick={addColor} style={{ minWidth: 24, padding: '2px 4px', fontSize: 16, lineHeight: 1 }}>+</Button>
        )}
      </div>
      <Button size="small" onClick={onAutoSuggest} style={{ marginTop: 4, fontSize: 10, padding: '2px 6px' }}>
        Auto-suggest
      </Button>
    </div>
  );
}

function AppDrawer(props) {
  const classes = madeStyles();

  return (
    <Drawer variant="permanent" anchor="left" className={classes.drawer} classes={{ paper: classes.drawerPaper }}>
      <List spacing={0}>
        <ListItem>
          <ParameterSlider min={0} max={100} value={props.resolution} onChange={(e, c) => props.onChange({ resolution: c })} title="Resolution" tooltip="Size of the result" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0.1} max={16} value={props.lineWidth} onChange={(e, c) => props.onChange({ lineWidth: c })} step={0.1} title="Stroke width" tooltip="How thick the line should be" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0} max={100} value={props.contrast} onChange={(e, c) => props.onChange({ contrast: c })} title="Contrast" tooltip="The difference in density between black and white areas" />
        </ListItem>
        <ListItem>
          <ParameterSlider min={0} max={255} value={props.whiteCutoff} onChange={(e, c) => props.onChange({ whiteCutoff: c })} title="White cutoff" tooltip="How white an area has to be to not draw in it" />
        </ListItem>
        <ListItem style={{ marginTop: -10 }}>
          <ParameterCheckbox value={props.invert} onChange={(e, c) => props.onChange({ invert: c })} title="Invert image" tooltip="Fill white instead of black" />
        </ListItem>
        <ListItem style={{ marginTop: -10 }}>
          <div style={{ width: '100%' }}>
            <Typography variant="caption" style={{ display: 'block', marginBottom: 4 }}>Thread colors</Typography>
            <ColorPaletteEditor
              colors={props.colors}
              onChange={colors => props.onChange({ colors })}
              onAutoSuggest={props.onAutoSuggest}
            />
            <div style={{ display: 'flex', alignItems: 'center', marginTop: 8 }}>
              <Typography variant="caption" style={{ marginRight: 8 }}>Background</Typography>
              <ColorPicker value={props.bg} hideTextfield disableAlpha onChange={c => props.onChange({ bg: c })} />
            </div>
          </div>
        </ListItem>
        <Button variant="contained" onClick={props.onResetParams} className={classes.highButton}>Reset</Button>
        <Divider />
        <Button variant="contained" color="primary" onClick={props.onNewImage} className={classes.lowButton} disabled={!props.canSelect}>Choose Image</Button>
        <Button variant="contained" color="primary" onClick={props.onDownloadSVG} className={classes.lowButton} disabled={!props.canDownload}>Download SVG</Button>
        <Button variant="contained" color="primary" onClick={props.onDownloadPNG} className={classes.lowHighButton} disabled={!props.canDownload}>Download PNG</Button>
        <Divider />
        <Button variant="contained" onClick={props.onFeedback} className={classes.lowButton}>Feedback (FB)</Button>
      </List>
    </Drawer>
  );
}

function loadFromImg(props, event) {
  let xhttp = new XMLHttpRequest();
  xhttp.responseType = "arraybuffer";
  xhttp.onreadystatechange = function () {
    if (this.readyState === 4) {
      if (this.status === 200) {
        onImageSelect(props, xhttp.response);
      } else {
        console.log("Can't load image", xhttp);
      }
    }
  };
  xhttp.open("GET", event.target.src, true);
  xhttp.send();
}

function loadFromFile(props, event) {
  if (event.target.files.length === 0) return;
  const reader = new FileReader();
  reader.onload = e => readerOnLoad(props, e);
  reader.onerror = () => {};
  reader.readAsArrayBuffer(event.target.files[0]);
}

function readerOnLoad(props, event) {
  onImageSelect(props, event.target.result);
}

function onImageSelect(props, arrayBuffer) {
  props.onImageSelected({ data: arrayBuffer });
}

function ImageSelector(props) {
  const classes = madeStyles();
  const onClick = e => { props.onImageLoading(e); loadFromImg(props, e); };
  const onFile = e => { props.onImageLoading(e); loadFromFile(props, e); };
  return (
    <div id="imageSelector" style={{ textAlign: "center", width: "100%", position: "absolute", top: "50%", transform: "translateY(-50%)", zIndex: "1" }}>
      <div className={classes.imageSelector}>
        <div>
          <div style={{ display: "flex", flexDirection: "column", justifyContent: "center" }}>
            <Typography variant="h5">Try an example</Typography>
            <div style={{ paddingTop: "20px", paddingBottom: "20px" }}>
              <ImageExample onClick={onClick} src={exPig} title="Draw me like one of your French pigs. Oinque." />
              <ImageExample onClick={onClick} src={exWorld} title="Around the world, around the world, around the world, around the world - Daft Punk" />
              <ImageExample onClick={onClick} src={exDog} title="I've heard humans say it's a doggy dog world, and I couldn't agree more." />
            </div>
            <BorderWithText text="or" />
            <div>
              <Typography variant="h5" style={{ paddingTop: "20px", paddingBottom: "20px" }}>Upload your own</Typography>
              <input type="file" id="file" onChange={onFile} accept="image/*" title="The image is processed locally and never uploaded." />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Spinner(props) {
  const classes = madeStyles();
  return (
    <div style={{ textAlign: "center", width: "100%", position: "absolute", top: "50%", transform: "translateY(-50%)", zIndex: "1" }}>
      <div className={classes.imageSelector}>
        <CircularProgress color="primary" style={{ marginTop: 10, marginBottom: 10 }} />
        <Typography>{props.children}</Typography>
      </div>
    </div>
  );
}

function ErrorMessage(props) {
  const classes = madeStyles();
  return (
    <div style={{ textAlign: "center", width: "100%", position: "absolute", top: "50%", transform: "translateY(-50%)", zIndex: "1" }}>
      <div className={classes.errorBox}>
        <Typography>{props.children}</Typography>
        <br />
        <Button variant="contained" color="primary" onClick={props.onAccept}>Ok</Button>
      </div>
    </div>
  );
}

function BorderWithText(props) {
  const borderStyle = { borderBottom: "1px solid #aaa", width: "100%", height: "1px" };
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <div className="border" style={borderStyle} />
      <span style={{ marginLeft: "0.5em", marginRight: "0.5em", marginTop: "-0.1em" }}>{props.text}</span>
      <div className="border" style={borderStyle} />
    </div>
  );
}

function ImageExample(props) {
  return (
    <Button onClick={props.onClick} style={{ padding: "0px" }}>
      <img src={props.src} style={{ height: "100px" }} alt={props.title} title={props.title} />
    </Button>
  );
}

export default withStyles(styles)(App);
