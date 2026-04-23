// 定义3D可视化区域
const NANSHAN_BBOX = [106.57532902, 29.52244874, 106.63145015, 29.54789112];    // [west, south, east, north]

const panoModal = document.getElementById('panoModal');
const panoFrame = document.getElementById('panoFrame');
const panoTitle = document.getElementById('panoTitle');
const panoImage = document.getElementById('panoImage');
const viewerWrap = document.getElementById('viewerWrap');

let imgScale = 1;
let imgMinScale = 1;
let imgMaxScale = 5;
let imgTranslateX = 0;
let imgTranslateY = 0;

let isDraggingImage = false;
let dragStartX = 0;
let dragStartY = 0;
let dragOriginX = 0;
let dragOriginY = 0;

let pointers = new Map();
let pinchStartDistance = 0;
let pinchStartScale = 1;

const map = new maplibregl.Map({
  container: 'map',
  center: [106.55, 29.56],
  zoom: 13.5,
  pitch: 70,
  bearing: 20,
  maxPitch: 60,
  minZoom: 11,
  maxZoom: 18,
  antialias: false,
  hash: true,
  style: {
    version: 8,
    sources: {
      osm: {
        type: 'raster',
        tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
        tileSize: 256,
        //bounds: NANSHAN_BBOX,    // 底图限制到南山附近
        attribution: '© OpenStreetMap contributors',
        maxzoom: 16
      },
      terrainSource: {
        type: 'raster-dem',
        url: 'https://tiles.mapterhorn.com/tilejson.json',
        bounds: NANSHAN_BBOX,  // 关键：只请求南山附近 DEM
        tileSize: 256,
        maxzoom: 14
      },
      hillshadeSource: {
        type: 'raster-dem',
        url: 'https://tiles.mapterhorn.com/tilejson.json',
        bounds: NANSHAN_BBOX,  // 同样限制
        tileSize: 256,
        maxzoom: 14
      }
    },
    layers: [
      {
        id: 'osm',
        type: 'raster',
        source: 'osm'
      },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'hillshadeSource',
        minzoom: 12,   // 低缩放不显示山体阴影
        paint: {
          'hillshade-shadow-color': '#473B24'
        }
      }
    ],
    terrain: {
      source: 'terrainSource',
      exaggeration: 1.2
    }
  }
});

map.addControl(
  new maplibregl.NavigationControl({
    visualizePitch: true,
    showZoom: true,
    showCompass: true
  }),
  'top-right'
);




/** 处理excel函数 */

let workbook = null;

/** 读取 Excel 工作簿 */
async function loadWorkbook(url) {
  const data = await (await fetch(url)).arrayBuffer();
  workbook = XLSX.read(data);
  return workbook;
}

/** 取某个 sheet 的行数据 */
function getSheetRows(sheetName) {
  if (!workbook) throw new Error('workbook 尚未加载');
  const ws = workbook.Sheets[sheetName];
  if (!ws) throw new Error(`找不到 sheet: ${sheetName}`);

  // 转成对象数组
  const rows = XLSX.utils.sheet_to_json(ws, {
    defval: '',   // 空单元格给默认值，避免 undefined
    raw: true
  });

  return rows;
}

/** 从一行里取经纬度，兼容 lng/lat 或 Ing/Iat */
function getLngLat(row) {
  const lngRaw = row.lng ?? row.Lng ?? row.LNG ?? row.Ing ?? row.ing;
  const latRaw = row.lat ?? row.Lat ?? row.LAT ?? row.Iat ?? row.iat;

  const lng = Number(lngRaw);
  const lat = Number(latRaw);

  if (!Number.isFinite(lng) || !Number.isFinite(lat)) {
    return null;
  }

  return [lng, lat];
}

/** 按 seq 排序 */
function sortRows(rows) {
  return [...rows].sort((a, b) => {
    const sa = Number(a.seq ?? 0);
    const sb = Number(b.seq ?? 0);
    return sa - sb;
  });
}

/** sheet -> route GeoJSON */
function buildRouteGeoJSON(sheetName) {
  const rows = sortRows(getSheetRows(sheetName));

  const coordinates = rows
    .map(getLngLat)
    .filter(Boolean);

  return {
    type: 'FeatureCollection',
    features: [
      {
        type: 'Feature',
        properties: {
          name: sheetName
        },
        geometry: {
          type: 'LineString',
          coordinates
        }
      }
    ]
  };
}

/** sheet -> poi GeoJSON */
function buildPoiGeoJSON(sheetName) {
  const rows = sortRows(getSheetRows(sheetName));

  const features = rows
    .map(row => {
      // 🔥 新增：跳过 type 为 'mid' 的点
      if (row.type === 'mid') {
        return null;
      }

      const lngLat = getLngLat(row);
      if (!lngLat) return null;

      return {
        type: 'Feature',
        properties: {
          seq: Number(row.seq ?? 0),
          title: row.title ?? '',
          type: row.type ?? '',
          source: row.source ?? '',
          note: row.note ?? '',
          verified: row.verified ?? '',
          date: row.date ?? '',
          panoUrl: row.panoUrl ?? row.imageUrl ?? ''
        },
        geometry: {
          type: 'Point',
          coordinates: lngLat
        }
      };
    })
    .filter(Boolean);   // 这里会自动过滤掉 null

  return {
    type: 'FeatureCollection',
    features
  };
}



function isImageUrl(url = '') {
  return /\.(jpg|jpeg|png|webp|gif|bmp|svg)$/i.test(url.split('?')[0]);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function getDistance(p1, p2) {
  const dx = p2.clientX - p1.clientX;
  const dy = p2.clientY - p1.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function resetImageTransform() {
  fitImageToScreen();
}

function fitImageToScreen() {
  if (!panoImage.naturalWidth || !panoImage.naturalHeight) return;

  const wrapRect = viewerWrap.getBoundingClientRect();
  const wrapWidth = wrapRect.width;
  const wrapHeight = wrapRect.height;

  const imgWidth = panoImage.naturalWidth;
  const imgHeight = panoImage.naturalHeight;

  if (!wrapWidth || !wrapHeight || !imgWidth || !imgHeight) return;

  // 计算“完整放进容器”的缩放比例
  const scaleX = wrapWidth / imgWidth;
  const scaleY = wrapHeight / imgHeight;
  const fitScale = Math.min(scaleX, scaleY);

  imgMinScale = fitScale;
  imgScale = fitScale;

  imgTranslateX = 0;
  imgTranslateY = 0;

  applyImageTransform();
}

function applyImageTransform() {
  panoImage.style.transform =
    `translate(${imgTranslateX}px, ${imgTranslateY}px) scale(${imgScale})`;
}

function openPano(url, title) {
  if (!url) return;

  panoTitle.textContent = title || '实景全景';

  if (isImageUrl(url)) {
    panoFrame.src = '';
    panoFrame.style.display = 'none';

    panoImage.style.display = 'block';
    panoImage.src = url;

    panoImage.onload = () => {
      fitImageToScreen();
    };
  } else {
    panoImage.src = '';
    panoImage.style.display = 'none';

    panoFrame.src = url;
    panoFrame.style.display = 'block';
  }

  panoModal.classList.add('show');
}

function closePano() {
  panoModal.classList.remove('show');

  panoFrame.src = '';
  panoFrame.style.display = 'none';

  panoImage.src = '';
  panoImage.style.display = 'none';

  resetImageTransform();
  pointers.clear();
}

// 自动缩放到当前路线
function fitMapToRoute(routeGeoJSON) {
  const bounds = new maplibregl.LngLatBounds();
  const coords = routeGeoJSON.features[0].geometry.coordinates;
  coords.forEach(coord => bounds.extend(coord));
  map.fitBounds(bounds, {
    padding: 60,
    maxZoom: 16,
    duration: 800
  });
}

function switchRoute(sheetName) {
  const routeData = buildRouteGeoJSON(sheetName);
  const poiData = buildPoiGeoJSON(sheetName);
  map.getSource('route').setData(routeData);
  map.getSource('pois').setData(poiData);
  fitMapToRoute(routeData);
}

document.getElementById('closePano').addEventListener('click', closePano);

document.getElementById('btn3d').addEventListener('click', () => {
  map.easeTo({ pitch: 70, bearing: 20, duration: 800 });
});

document.getElementById('btn2d').addEventListener('click', () => {
  map.easeTo({ pitch: 0, bearing: 0, duration: 800 });
});

document.getElementById('btnReset').addEventListener('click', () => {
  const firstSheet = workbook?.SheetNames?.[0];
  if (!firstSheet) return;

  const routeData = buildRouteGeoJSON(firstSheet);
  fitMapToRoute(routeData);

  map.easeTo({
    pitch: 60,
    bearing: 20,
    duration: 1000
  });
});

map.on('load', async () => {
  await loadWorkbook('./data/routes.xlsx');

  const firstSheet = workbook.SheetNames[0];

  const routeData = buildRouteGeoJSON(firstSheet);
  const poiData = buildPoiGeoJSON(firstSheet);

  map.addSource('route', {
    type: 'geojson',
    data: routeData
  });

  map.addLayer({
    id: 'route-outline',
    type: 'line',
    source: 'route',
    layout: {
      'line-cap': 'round',
      'line-join': 'round'
    },
    paint: {
      'line-color': '#ffffff',
      'line-width': 10,
      'line-opacity': 0.95
    }
  });

  map.addLayer({
    id: 'route-main',
    type: 'line',
    source: 'route',
    layout: {
      'line-cap': 'round',
      'line-join': 'round'
    },
    paint: {
      'line-color': '#ff5a3c',
      'line-width': 6
    }
  });

  map.addSource('pois', {
    type: 'geojson',
    data: poiData
  });

  map.addLayer({
    id: 'poi-circle',
    type: 'circle',
    source: 'pois',
    paint: {
      'circle-radius': 7,
      'circle-color': [
        'match',
        ['get', 'type'],
        'start', '#16a34a',
        'entry', '#0ea5e9',
        'junction', '#2563eb',
        'mid', '#64748b',
        'landmark', '#7b13cfff',
        'end', '#dc2626',
        '#64748b'
      ],
      'circle-stroke-width': 2,
      'circle-stroke-color': '#ffffff'
    }
  });

  map.addLayer({
    id: 'poi-label',
    type: 'symbol',
    source: 'pois',
    layout: {
      'text-field': ['get', 'title'],
      'text-size': 12,
      'text-offset': [0, 1.3],
      'text-anchor': 'top'
    },
    paint: {
      'text-color': '#111827',
      'text-halo-color': '#ffffff',
      'text-halo-width': 1
    }
  });

  fitMapToRoute(routeData);
});


// 点击点位弹窗
map.on('click', 'poi-circle', (e) => {
  const feature = e.features[0];
  const props = feature.properties;
  const lngLat = feature.geometry.coordinates.slice();

  const box = document.createElement('div');
  box.className = 'popup-card';

  const title = document.createElement('h3');
  title.textContent = props.title || '未命名点位';

  const typeText = document.createElement('p');
  typeText.innerHTML = `<b>类型：</b>${props.type || ''}`;

  const note = document.createElement('p');
  note.innerHTML = `<b>提示：</b>${props.note || '暂无提示信息'}`;

  const source = document.createElement('p');
  source.innerHTML = `<b>来源：</b>${props.source || ''}`;

  box.appendChild(title);
  box.appendChild(typeText);
  box.appendChild(note);
  box.appendChild(source);

  // 如果是图片，可以在弹窗里先显示一张小预览图
  if (props.panoUrl && isImageUrl(props.panoUrl)) {
    const preview = document.createElement('img');
    preview.src = props.panoUrl;
    preview.alt = props.title || '';
    preview.style.width = '100%';
    preview.style.borderRadius = '8px';
    preview.style.marginTop = '8px';
    preview.style.display = 'block';
    box.appendChild(preview);
  }

  // 有 panoUrl 才显示按钮
  if (props.panoUrl) {
    const btn = document.createElement('button');
    btn.textContent = '查看实景';
    btn.addEventListener('click', () => {
      openPano(props.panoUrl, props.title);
    });
    box.appendChild(btn);
  }

  new maplibregl.Popup({ offset: 15 })
    .setLngLat(lngLat)
    .setDOMContent(box)
    .addTo(map);
});

map.on('mouseenter', 'poi-circle', () => {
  map.getCanvas().style.cursor = 'pointer';
});

map.on('mouseleave', 'poi-circle', () => {
  map.getCanvas().style.cursor = '';
});

// 开发期很有用：点击地图打印经纬度和海拔
map.on('click', (e) => {
  const elevation = map.queryTerrainElevation(e.lngLat);
  console.log(
    '经度:', e.lngLat.lng.toFixed(6),
    '纬度:', e.lngLat.lat.toFixed(6),
    '海拔(米):', elevation
  );
});
map.on('idle', () => {
  console.log('terrain =', map.getTerrain());
});

// 给图片加鼠标滚轮缩放
viewerWrap.addEventListener('wheel', (e) => {
  if (panoImage.style.display !== 'block') return;

  e.preventDefault();

  const scaleStep = e.deltaY < 0 ? 1.1 : 0.9;
  imgScale = clamp(imgScale * scaleStep, imgMinScale, imgMaxScale);

  applyImageTransform();
}, { passive: false });

// 给图片加鼠标拖动
panoImage.addEventListener('pointerdown', (e) => {
  if (panoImage.style.display !== 'block') return;

  panoImage.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, e);

  if (pointers.size === 1) {
    isDraggingImage = true;
    panoImage.classList.add('dragging');

    dragStartX = e.clientX;
    dragStartY = e.clientY;
    dragOriginX = imgTranslateX;
    dragOriginY = imgTranslateY;
  }

  if (pointers.size === 2) {
    const pts = [...pointers.values()];
    pinchStartDistance = getDistance(pts[0], pts[1]);
    pinchStartScale = imgScale;
    isDraggingImage = false;
    panoImage.classList.remove('dragging');
  }
});

panoImage.addEventListener('pointermove', (e) => {
  if (panoImage.style.display !== 'block') return;

  if (pointers.has(e.pointerId)) {
    pointers.set(e.pointerId, e);
  }

  if (pointers.size === 2) {
    const pts = [...pointers.values()];
    const dist = getDistance(pts[0], pts[1]);

    if (pinchStartDistance > 0) {
      imgScale = clamp(
        pinchStartScale * (dist / pinchStartDistance),
        imgMinScale,
        imgMaxScale
      );
      applyImageTransform();
    }
    return;
  }

  if (!isDraggingImage) return;

  const dx = e.clientX - dragStartX;
  const dy = e.clientY - dragStartY;

  imgTranslateX = dragOriginX + dx;
  imgTranslateY = dragOriginY + dy;

  applyImageTransform();
});

function endPointer(e) {
  pointers.delete(e.pointerId);

  if (pointers.size < 2) {
    pinchStartDistance = 0;
  }

  if (pointers.size === 0) {
    isDraggingImage = false;
    panoImage.classList.remove('dragging');
  }
}

panoImage.addEventListener('pointerup', endPointer);
panoImage.addEventListener('pointercancel', endPointer);

// 双击恢复原始大小
panoImage.addEventListener('dblclick', () => {
  resetImageTransform();
});

// 点击遮罩关闭
panoModal.addEventListener('click', (e) => {
  if (e.target === panoModal) {
    closePano();
  }
});