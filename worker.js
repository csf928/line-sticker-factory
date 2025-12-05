// worker.js

// --- Helper Functions (從您的 App.js 複製過來的) ---

const hexToRgb = (hex) => {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result ? {
        r: parseInt(result[1], 16),
        g: parseInt(result[2], 16),
        b: parseInt(result[3], 16)
    } : null;
};

// HSV 邏輯 (用於 #00FF00 純綠色幕去背)
const isPixelBackgroundHSV = (r, g, b, tolerancePercent) => {
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    if (delta !== 0) {
        if (max === g) hue = 60 * ((b - r) / delta + 2);
        else if (max === r) hue = 60 * ((g - b) / delta + 4);
        else hue = 60 * ((r - g) / delta);
    }
    if (hue < 0) hue += 360;
    const saturation = max === 0 ? 0 : delta / max;
    const value = max / 255;
    
    // 綠色範圍 H: 60-180
    const toleranceFactor = tolerancePercent / 100;
    const minSat = 0.25 * (1 - toleranceFactor); // 調整飽和度範圍
    const minVal = 0.35 * (1 - toleranceFactor); // 調整亮度範圍
    
    const isGreenHue = (hue >= 60 && hue <= 180);
    const isStandardGreenScreen = isGreenHue && saturation > minSat && value > minVal;
    
    // 額外判斷綠色是否明顯佔優勢
    const isDominantGreen = (g > r + 30) && (g > b + 30) && (g > 80);
    
    return isStandardGreenScreen || isDominantGreen;
};

// RGB 距離邏輯 (用於一般顏色去背，如 #000000 黑底)
const isTargetColorRGB = (r, g, b, targetRgb, toleranceDist) => {
    // 歐幾里德距離
    const dist = Math.sqrt(Math.pow(r - targetRgb.r, 2) + Math.pow(g - targetRgb.g, 2) + Math.pow(b - targetRgb.b, 2));
    return dist <= toleranceDist;
};

const isPixelBackground = (r, g, b, targetHex, tolerancePercent) => {
    if (targetHex.toLowerCase() === '#00ff00') {
        // 使用 HSV 邏輯 (專為綠幕優化)
        return isPixelBackgroundHSV(r, g, b, tolerancePercent);
    } else {
        // 使用 RGB 距離邏輯 (適用於其他顏色)
        const targetRgb = hexToRgb(targetHex) || {r:0, g:0, b:0};
        const maxDist = 442; // RGB(0,0,0) 到 RGB(255,255,255) 的最大距離
        const toleranceDist = maxDist * (tolerancePercent / 100);
        return isTargetColorRGB(r, g, b, targetRgb, toleranceDist);
    }
};

const removeBgGlobal = (imgData, targetHex, tolerancePercent) => {
    const data = imgData.data;
    const len = data.length;
    for (let i = 0; i < len; i += 4) {
        if (isPixelBackground(data[i], data[i+1], data[i+2], targetHex, tolerancePercent)) {
            data[i+3] = 0; // 設定 Alpha 為 0 (完全透明)
        }
    }
    return imgData;
};

const removeBgFloodFill = (imgData, w, h, targetHex, tolerancePercent) => {
    const data = imgData.data;
    // 由於 Flood Fill 需要檢查邊界，從四個角落開始向內填充
    const stack = [[0,0], [w-1,0], [0,h-1], [w-1,h-1]];
    const visited = new Uint8Array(w*h);
    
    while(stack.length) {
        const [x, y] = stack.pop();
        const offset = y*w + x;

        // 檢查邊界和是否已拜訪
        if (x < 0 || x >= w || y < 0 || y >= h || visited[offset]) continue;
        visited[offset] = 1;

        const idx = offset * 4;
        
        // 如果這個像素是背景色
        if (isPixelBackground(data[idx], data[idx+1], data[idx+2], targetHex, tolerancePercent)) {
            data[idx+3] = 0; // 設定透明
            
            // 往四個方向繼續擴散
            stack.push([x+1, y], [x-1, y], [x, y+1], [x, y-1]);
        }
    }
    return imgData;
};

const applyErosion = (imgData, w, h, strength) => {
    if (strength <= 0) return imgData;

    const data = imgData.data;
    
    // 進行多次侵蝕 (依據 strength)
    for (let k = 0; k < strength; k++) {
        // 複製 Alpha 通道用於下一輪運算 (避免立即修改影響當前邊緣判斷)
        const currentAlpha = new Uint8Array(w * h);
        for(let i=0; i<w*h; i++) currentAlpha[i] = data[i*4+3];

        for (let y = 1; y < h-1; y++) {
            for (let x = 1; x < w-1; x++) {
                const idx = y*w + x;
                
                // 如果當前像素是不透明的 (前景)
                if (currentAlpha[idx] > 0) {
                    // 檢查它上下左右四個鄰居是否有透明的 (即邊緣)
                    if (currentAlpha[idx-1] === 0 || currentAlpha[idx+1] === 0 || 
                        currentAlpha[idx-w] === 0 || currentAlpha[idx+w] === 0) {
                        
                        // 將邊緣像素設為透明 (侵蝕)
                        data[idx*4+3] = 0; 
                    }
                }
            }
        }
    }
    return imgData;
};

// --- Web Worker Main Listener ---

self.onmessage = function(e) {
    const { id, rawImageData, removalMode, targetColorHex, colorTolerance, erodeStrength, width, height } = e.data;
    
    // 複製一份 ImageData，確保不會修改傳輸來的原始資料
    let processedImageData = rawImageData; 
    
    // 執行去背
    if (removalMode === 'flood') {
        // Flood Fill 模式
        processedImageData = removeBgFloodFill(processedImageData, width, height, targetColorHex, colorTolerance);
    } else {
        // Global 模式 (更簡單的顏色判斷)
        processedImageData = removeBgGlobal(processedImageData, targetColorHex, colorTolerance);
    }
    
    // 執行邊緣侵蝕
    processedImageData = applyErosion(processedImageData, width, height, erodeStrength);
    
    // 將結果傳回主執行緒 (使用 transferables 加速)
    self.postMessage({ id: id, processedImageData: processedImageData }, [processedImageData.data.buffer]);
};
