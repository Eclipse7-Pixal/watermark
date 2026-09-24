// Global PDF.js Worker Configuration
pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

// Global Application State
let filesArray = [];
let currentMergedPdfBytes = null;
let currentCleanedPdfBytes = null;
let currentStep = 1;
let sortableInstance = null;

// Helper: Async Delay to keep UI Responsive & Avoid Worker Conflicts
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Safely Clone ArrayBuffer to prevent Detached ArrayBuffer errors
function cloneBuffer(buffer) {
    return buffer.slice(0);
}

// UI Navigation Stepper
function goToStep(step) {
    currentStep = step;
    for (let i = 1; i <= 4; i++) {
        const stepContent = document.getElementById(`step-${i}`);
        const stepBtn = document.getElementById(`step-btn-${i}`);
        const stepLine = document.getElementById(`line-${i}`);

        if (i === step) {
            stepContent.classList.remove('hidden');
            stepBtn.className = "step active";
        } else if (i < step) {
            stepContent.classList.add('hidden');
            stepBtn.className = "step completed";
            if (stepLine) stepLine.classList.add('active');
        } else {
            stepContent.classList.add('hidden');
            stepBtn.className = "step";
            if (stepLine) stepLine.classList.remove('active');
        }
    }
}

function showLoader(msg = "Processing your PDF...") {
    document.getElementById('loader-text').innerText = msg;
    document.getElementById('loader').classList.remove('hidden');
}

function hideLoader() {
    document.getElementById('loader').classList.add('hidden');
}

function showAlert(msg) {
    document.getElementById('alert-msg').innerText = msg;
    document.getElementById('alert-box').classList.remove('hidden');
}

function hideAlert() {
    document.getElementById('alert-box').classList.add('hidden');
}

// STEP 1: FILE MERGE HANDLING
const fileInput = document.getElementById('file-input');
const dropZone = document.getElementById('drop-zone');

fileInput.addEventListener('change', (e) => handleFiles(e.target.files));

dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
});

dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));

dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    handleFiles(e.dataTransfer.files);
});

async function handleFiles(files) {
    for (const file of files) {
        if (file.type === 'application/pdf') {
            const buffer = await file.arrayBuffer();
            filesArray.push({
                id: Math.random().toString(36).substr(2, 9),
                name: file.name,
                size: (file.size / (1024 * 1024)).toFixed(2) + ' MB',
                buffer: buffer
            });
        }
    }
    renderFileList();
}

function renderFileList() {
    const listEl = document.getElementById('file-list');
    const container = document.getElementById('file-list-container');
    const countEl = document.getElementById('file-count');

    listEl.innerHTML = '';
    if (filesArray.length === 0) {
        container.classList.add('hidden');
        return;
    }

    container.classList.remove('hidden');
    countEl.innerText = filesArray.length;

    filesArray.forEach((file) => {
        const li = document.createElement('li');
        li.className = 'file-item';
        li.dataset.id = file.id;
        li.innerHTML = `
            <div class="file-info">
                <span>☰</span>
                <strong>${file.name}</strong>
                <span style="color:#94a3b8; font-size:0.8rem;">(${file.size})</span>
            </div>
            <button class="remove-btn" onclick="removeFile('${file.id}')">&times;</button>
        `;
        listEl.appendChild(li);
    });

    if (sortableInstance) sortableInstance.destroy();
    sortableInstance = new Sortable(listEl, {
        animation: 150,
        onEnd: () => {
            const newOrder = [];
            listEl.querySelectorAll('.file-item').forEach(el => {
                const id = el.dataset.id;
                const found = filesArray.find(f => f.id === id);
                if (found) newOrder.push(found);
            });
            filesArray = newOrder;
        }
    });
}

function removeFile(id) {
    filesArray = filesArray.filter(f => f.id !== id);
    renderFileList();
}

function clearAllFiles() {
    filesArray = [];
    renderFileList();
}

async function processStep1() {
    if (filesArray.length === 0) return;
    showLoader("Merging PDF Documents...");
    await delay(100);

    try {
        const mergedPdf = await PDFLib.PDFDocument.create();

        for (const fileObj of filesArray) {
            // ALWAYS pass a cloned buffer to avoid detachment issues
            const srcDoc = await PDFLib.PDFDocument.load(cloneBuffer(fileObj.buffer));
            const copiedPages = await mergedPdf.copyPages(srcDoc, srcDoc.getPageIndices());
            copiedPages.forEach(page => mergedPdf.addPage(page));
        }

        currentMergedPdfBytes = await mergedPdf.save();
        await renderStep2Preview();
        hideLoader();
        goToStep(2);
    } catch (err) {
        hideLoader();
        showAlert("Error merging files: " + err.message);
    }
}

// STEP 2: ASSET CLEANING
async function renderStep2Preview() {
    if (!currentMergedPdfBytes) return;
    // ALWAYS pass a cloned buffer to PDF.js
    const pdfDoc = await pdfjsLib.getDocument({ data: cloneBuffer(currentMergedPdfBytes) }).promise;
    const page = await pdfDoc.getPage(1);

    const viewport = page.getViewport({ scale: 1.0 });
    const canvas = document.getElementById('step2-canvas');
    const ctx = canvas.getContext('2d');

    canvas.width = viewport.width;
    canvas.height = viewport.height;

    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
}

async function processStep2() {
    showLoader("Filtering and Cleaning Assets...");
    await delay(100);

    try {
        const removeText = document.getElementById('remove-text').checked;
        const removeImages = document.getElementById('remove-images').checked;
        const removeVectors = document.getElementById('remove-vectors').checked;

        // Load document using safe buffer copy
        const pdfDoc = await pdfjsLib.getDocument({ data: cloneBuffer(currentMergedPdfBytes) }).promise;
        const newPdf = await PDFLib.PDFDocument.create();

        for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
            const page = await pdfDoc.getPage(pageNum);
            const viewport = page.getViewport({ scale: 2.0 });

            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');

            await page.render({ canvasContext: ctx, viewport: viewport }).promise;

            // Apply Asset Filter Overlays if selected
            if (removeText || removeImages || removeVectors) {
                const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
                const data = imgData.data;

                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i], g = data[i+1], b = data[i+2];
                    const isWhite = r > 240 && g > 240 && b > 240;

                    if (!isWhite) {
                        const isTextLike = (r < 50 && g < 50 && b < 50);
                        if (removeText && isTextLike) {
                            data[i] = 255; data[i+1] = 255; data[i+2] = 255;
                        } else if (removeImages || removeVectors) {
                            data[i] = 255; data[i+1] = 255; data[i+2] = 255;
                        }
                    }
                }
                ctx.putImageData(imgData, 0, 0);
            }

            const imgUrl = canvas.toDataURL('image/jpeg', 0.92);
            const imgBytes = await fetch(imgUrl).then(res => res.arrayBuffer());
            const embeddedImg = await newPdf.embedJpg(imgBytes);

            const newPage = newPdf.addPage([page.view[2], page.view[3]]);
            newPage.drawImage(embeddedImg, {
                x: 0,
                y: 0,
                width: page.view[2],
                height: page.view[3]
            });
        }

        currentCleanedPdfBytes = await newPdf.save();
        await initStep3Crop();
        hideLoader();
        goToStep(3);
    } catch (err) {
        hideLoader();
        showAlert("Error cleaning assets: " + err.message);
    }
}

// STEP 3: CROP & A4 RESIZING
let cropCanvas, cropCtx, cropBoxEl;
let isDragging = false, isResizing = false;
let currentHandle = null;
let startX, startY, startLeft, startTop, startWidth, startHeight;

async function initStep3Crop() {
    cropCanvas = document.getElementById('crop-canvas');
    cropCtx = cropCanvas.getContext('2d');
    cropBoxEl = document.getElementById('crop-box');

    // Load document using safe buffer copy
    const pdfDoc = await pdfjsLib.getDocument({ data: cloneBuffer(currentCleanedPdfBytes) }).promise;
    const page = await pdfDoc.getPage(1);
    const viewport = page.getViewport({ scale: 1.0 });

    cropCanvas.width = viewport.width;
    cropCanvas.height = viewport.height;

    await page.render({ canvasContext: cropCtx, viewport: viewport }).promise;

    // Default crop box margins
    resetCropBox();
    initCropEvents();
}

function resetCropBox() {
    const margin = 20;
    const w = cropCanvas.width - (margin * 2);
    const h = cropCanvas.height - (margin * 2);

    cropBoxEl.style.left = `${margin}px`;
    cropBoxEl.style.top = `${margin}px`;
    cropBoxEl.style.width = `${w}px`;
    cropBoxEl.style.height = `${h}px`;

    updateMarginInputs();
}

function updateMarginInputs() {
    const left = parseInt(cropBoxEl.style.left) || 0;
    const top = parseInt(cropBoxEl.style.top) || 0;
    const width = parseInt(cropBoxEl.style.width) || 0;
    const height = parseInt(cropBoxEl.style.height) || 0;

    document.getElementById('crop-left').value = Math.max(0, left);
    document.getElementById('crop-top').value = Math.max(0, top);
    document.getElementById('crop-right').value = Math.max(0, cropCanvas.width - (left + width));
    document.getElementById('crop-bottom').value = Math.max(0, cropCanvas.height - (top + height));
}

function initCropEvents() {
    const handles = cropBoxEl.querySelectorAll('.handle');

    handles.forEach(handle => {
        handle.addEventListener('mousedown', (e) => {
            e.stopPropagation();
            isResizing = true;
            currentHandle = handle;
            startX = e.clientX;
            startY = e.clientY;
            startLeft = cropBoxEl.offsetLeft;
            startTop = cropBoxEl.offsetTop;
            startWidth = cropBoxEl.offsetWidth;
            startHeight = cropBoxEl.offsetHeight;
        });
    });

    cropBoxEl.addEventListener('mousedown', (e) => {
        if (isResizing) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        startLeft = cropBoxEl.offsetLeft;
        startTop = cropBoxEl.offsetTop;
    });

    window.addEventListener('mousemove', (e) => {
        if (isDragging) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;
            const newLeft = Math.max(0, Math.min(cropCanvas.width - cropBoxEl.offsetWidth, startLeft + dx));
            const newTop = Math.max(0, Math.min(cropCanvas.height - cropBoxEl.offsetHeight, startTop + dy));

            cropBoxEl.style.left = `${newLeft}px`;
            cropBoxEl.style.top = `${newTop}px`;
            updateMarginInputs();
        } else if (isResizing) {
            const dx = e.clientX - startX;
            const dy = e.clientY - startY;

            if (currentHandle.classList.contains('handle-se')) {
                cropBoxEl.style.width = `${Math.max(50, startWidth + dx)}px`;
                cropBoxEl.style.height = `${Math.max(50, startHeight + dy)}px`;
            } else if (currentHandle.classList.contains('handle-sw')) {
                const newW = Math.max(50, startWidth - dx);
                cropBoxEl.style.width = `${newW}px`;
                cropBoxEl.style.left = `${startLeft + (startWidth - newW)}px`;
                cropBoxEl.style.height = `${Math.max(50, startHeight + dy)}px`;
            } else if (currentHandle.classList.contains('handle-ne')) {
                cropBoxEl.style.width = `${Math.max(50, startWidth + dx)}px`;
                const newH = Math.max(50, startHeight - dy);
                cropBoxEl.style.height = `${newH}px`;
                cropBoxEl.style.top = `${startTop + (startHeight - newH)}px`;
            } else if (currentHandle.classList.contains('handle-nw')) {
                const newW = Math.max(50, startWidth - dx);
                const newH = Math.max(50, startHeight - dy);
                cropBoxEl.style.width = `${newW}px`;
                cropBoxEl.style.left = `${startLeft + (startWidth - newW)}px`;
                cropBoxEl.style.height = `${newH}px`;
                cropBoxEl.style.top = `${startTop + (startHeight - newH)}px`;
            }
            updateMarginInputs();
        }
    });

    window.addEventListener('mouseup', () => {
        isDragging = false;
        isResizing = false;
    });

    ['crop-top', 'crop-bottom', 'crop-left', 'crop-right'].forEach(id => {
        document.getElementById(id).addEventListener('input', () => {
            const t = parseInt(document.getElementById('crop-top').value) || 0;
            const b = parseInt(document.getElementById('crop-bottom').value) || 0;
            const l = parseInt(document.getElementById('crop-left').value) || 0;
            const r = parseInt(document.getElementById('crop-right').value) || 0;

            cropBoxEl.style.left = `${l}px`;
            cropBoxEl.style.top = `${t}px`;
            cropBoxEl.style.width = `${Math.max(20, cropCanvas.width - l - r)}px`;
            cropBoxEl.style.height = `${Math.max(20, cropCanvas.height - t - b)}px`;
        });
    });
}

async function processStep3() {
    showLoader("Compiling Final PDF...");
    await delay(150);

    try {
        const normalizeA4 = document.getElementById('normalize-a4').checked;
        const cropX = parseInt(cropBoxEl.style.left);
        const cropY = parseInt(cropBoxEl.style.top);
        const cropW = parseInt(cropBoxEl.style.width);
        const cropH = parseInt(cropBoxEl.style.height);

        // Load document using safe buffer copy
        const pdfDoc = await pdfjsLib.getDocument({ data: cloneBuffer(currentCleanedPdfBytes) }).promise;
        const finalPdf = await PDFLib.PDFDocument.create();

        const A4_WIDTH = 595.28;
        const A4_HEIGHT = 841.89;

        for (let i = 1; i <= pdfDoc.numPages; i++) {
            const page = await pdfDoc.getPage(i);
            const scale = 2.0;
            const viewport = page.getViewport({ scale: scale });

            const canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            const ctx = canvas.getContext('2d');

            await page.render({ canvasContext: ctx, viewport: viewport }).promise;

            const croppedCanvas = document.createElement('canvas');
            croppedCanvas.width = cropW * scale;
            croppedCanvas.height = cropH * scale;
            const croppedCtx = croppedCanvas.getContext('2d');

            croppedCtx.drawImage(
                canvas,
                cropX * scale, cropY * scale, cropW * scale, cropH * scale,
                0, 0, cropW * scale, cropH * scale
            );

            const imgUrl = croppedCanvas.toDataURL('image/jpeg', 0.95);
            const imgBytes = await fetch(imgUrl).then(res => res.arrayBuffer());
            const embeddedImg = await finalPdf.embedJpg(imgBytes);

            if (normalizeA4) {
                const newPage = finalPdf.addPage([A4_WIDTH, A4_HEIGHT]);
                const aspectRatio = (cropW * scale) / (cropH * scale);
                let renderW = A4_WIDTH - 40;
                let renderH = renderW / aspectRatio;

                if (renderH > A4_HEIGHT - 40) {
                    renderH = A4_HEIGHT - 40;
                    renderW = renderH * aspectRatio;
                }

                const posX = (A4_WIDTH - renderW) / 2;
                const posY = A4_HEIGHT - renderH - 20; // Positioned upward

                newPage.drawImage(embeddedImg, { x: posX, y: posY, width: renderW, height: renderH });
            } else {
                const newPage = finalPdf.addPage([cropW, cropH]);
                newPage.drawImage(embeddedImg, { x: 0, y: 0, width: cropW, height: cropH });
            }
        }

        const finalBytes = await finalPdf.save();
        const blob = new Blob([finalBytes], { type: 'application/pdf' });
        const downloadUrl = URL.createObjectURL(blob);

        const dlBtn = document.getElementById('download-btn');
        dlBtn.href = downloadUrl;

        hideLoader();
        goToStep(4);
    } catch (err) {
        hideLoader();
        showAlert("An error occurred during final PDF compilation: " + err.message);
    }
}
