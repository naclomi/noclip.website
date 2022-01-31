import * as Viewer from '../viewer';
import * as Textures from './textures';
import * as RDP from '../Common/N64/RDP';
import * as RSP from '../Common/N64/RSP';
import * as F3DEX from '../BanjoKazooie/f3dex';
import * as Shadows from './shadows';
import * as Render from './render';

import * as RDPRenderModes from './rdp_render_modes';

import { assert, assertExists, align, nArray } from "../util";
import { F3DEX_Program } from "../BanjoKazooie/render";
import { mat4, vec3, vec4 } from "gl-matrix";
import { fillMatrix4x4, fillMatrix4x3, fillMatrix4x2, fillVec3v, fillVec4, fillVec4v } from '../gfx/helpers/UniformBufferHelpers';
import { GfxRenderInstManager, GfxRendererLayer, makeSortKey, setSortKeyDepth } from "../gfx/render/GfxRenderInstManager";
import { GfxDevice, GfxFormat, GfxTexture, GfxSampler, GfxBuffer, GfxBufferUsage, GfxInputLayout, GfxInputState, GfxVertexAttributeDescriptor, GfxVertexBufferFrequency, GfxBindingLayoutDescriptor, GfxBlendMode, GfxBlendFactor, GfxCullMode, GfxCompareMode, GfxMegaStateDescriptor, GfxProgram, GfxBufferFrequencyHint, GfxInputLayoutBufferDescriptor, makeTextureDescriptor2D } from "../gfx/platform/GfxPlatform";
import { GfxRenderCache } from '../gfx/render/GfxRenderCache';
import { ImageFormat, getImageFormatName, ImageSize, getImageSizeName, getSizBitsPerPixel } from "../Common/N64/Image";
import { DeviceProgram } from "../Program";
import { setAttachmentStateSimple } from '../gfx/helpers/GfxMegaStateDescriptorHelpers';

import { Color } from "../Color";

import { GloverTexbank } from './parsers';
import { Flipbook, FlipbookType } from './particles';
import { SRC_FRAME_TO_MS } from './timing';
import { subtractAngles } from './util';

const depthScratch = vec3.create();
const lookatScratch = vec3.create();
const projectionMatrixScratch = mat4.create();

interface SpriteRect {
    sX: number;
    sY: number;
    sW: number;
    sH: number;
    ulS: number;
    ulT: number;
    lrS: number;
    lrT: number;
};

class GloverBaseSpriteRenderer {
    protected drawCall: Render.DrawCall;
    protected textureCache: RDP.TextureCache;

    protected megaStateFlags: Partial<GfxMegaStateDescriptor>;

    protected frames: number[] = [];
    protected frame_textures: GloverTexbank.Texture[] = [];

    protected spriteRect: SpriteRect;

    protected sortKey: number;

    public visible: boolean = true;
    
    protected isBillboard: boolean = true;
    protected isOrtho: boolean = false;

    constructor(
        protected device: GfxDevice,
        protected cache: GfxRenderCache,
        protected textures: Textures.GloverTextureHolder,
        protected frameset: number[],
        protected xlu: boolean = false)
    {
        // TODO: figre out billboard flags
        if (xlu) {
            this.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT + Render.GloverRendererLayer.XLU_BILLBOARD);
        } else {
            this.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT + Render.GloverRendererLayer.OPAQUE_BILLBOARD);
        }

        this.megaStateFlags = {};

        setAttachmentStateSimple(this.megaStateFlags, {
            blendMode: GfxBlendMode.Add,
            blendSrcFactor: GfxBlendFactor.SrcAlpha,
            blendDstFactor: GfxBlendFactor.OneMinusSrcAlpha,
        });
    }

    protected initialize() {
        this.loadFrameset(this.frameset);
        const rect = {
            sW: 1.0,
            sH: 1.0,
            sX: -1/2,
            sY: -1/2,
            ulS: 0,
            ulT: 0,
            lrS: this.frame_textures[0].width * 32,
            lrT: this.frame_textures[0].height * 32
        };
        this.buildDrawCall(rect);
    }

    public cacheKey(): string {
        return String(this.frameset);
    }

    protected initializePipeline(rspState: Render.GloverRSPState) {
        Render.initializeRenderState(rspState);
        rspState.gSPSetGeometryMode(F3DEX.RSP_Geometry.G_ZBUFFER); // 0xB7000000 0x00000001
        if (this.xlu) {
            rspState.gDPSetCombine(0xfc119623, 0xff2fffff); // G_CC_MODULATEIA_PRIM, G_CC_MODULATEIA_PRIM
            // TODO: figure out which of these gets used:
            // rspState.gDPSetRenderMode(RDPRenderModes.G_RM_AA_ZB_TEX_EDGE, RDPRenderModes.G_RM_AA_ZB_TEX_EDGE2); // 0xb900031d 0x00504b50
            rspState.gDPSetRenderMode(RDPRenderModes.G_RM_ZB_CLD_SURF, RDPRenderModes.G_RM_ZB_CLD_SURF2); // 0xb900031d 0x00504b50
        } else {
            rspState.gDPSetCombine(0xfc119623, 0xff2fffff); // G_CC_MODULATEIDECALA, G_CC_PASS2
            rspState.gDPSetRenderMode(RDPRenderModes.G_RM_AA_ZB_TEX_EDGE, RDPRenderModes.G_RM_AA_ZB_TEX_EDGE2);
        }
        rspState.gDPSetPrimColor(0, 0, 0xFF, 0xFF, 0xFF, 0xFF); // 0xFA000000, (*0x801ec878) & 0xFF);
        rspState.gSPTexture(true, 0, 5, 0.999985 * 0x10000 / 32, 0.999985 * 0x10000 / 32);
    }

    protected loadFrameset(frameset: number[]): void {
        this.frame_textures = []
        for (let frame_id of frameset) {
            const texFile = this.textures.idToTexture.get(frame_id);
            if (texFile === undefined) {
                throw `Texture 0x${frame_id.toString(16)} not loaded`;
            }
            this.frame_textures.push(texFile);
        }
    }

    protected buildDrawCall(rect: SpriteRect, texSFlags: number = Render.G_TX_CLAMP | Render.G_TX_NOMIRROR, texTFlags: number = Render.G_TX_CLAMP | Render.G_TX_NOMIRROR) {
        const segments = this.textures.textureSegments();

        const rspState = new Render.GloverRSPState(segments, this.textures);

        this.initializePipeline(rspState);

        let drawCall = rspState._newDrawCall();

        this.frames = []
        for (let texture of this.frame_textures) {
            this.frames.push(Render.loadRspTexture(rspState, this.textures, texture.id, 
                texSFlags,
                texTFlags
            ))
        }

        drawCall.textureIndices.push(0);

        const spriteCoords = [
            [rect.sX, rect.sY + rect.sH, rect.ulS, rect.ulT],
            [rect.sX, rect.sY, rect.ulS, rect.lrT],
            [rect.sX + rect.sW, rect.sY + rect.sH, rect.lrS, rect.ulT],

            [rect.sX, rect.sY, rect.ulS, rect.lrT],
            [rect.sX + rect.sW, rect.sY, rect.lrS, rect.lrT],
            [rect.sX + rect.sW, rect.sY + rect.sH, rect.lrS, rect.ulT],
        ];

        for (let coords of spriteCoords) {
            const v = new F3DEX.Vertex();
            v.x = coords[0];
            v.y = coords[1];
            v.z = 0;
            v.tx = coords[2];
            v.ty = coords[3];
            v.c0 = 0xFF;
            v.c1 = 0xFF;
            v.c2 = 0xFF;
            v.a = 0xFF;
            drawCall.vertexCount += 1;
            drawCall.vertices.push(v)
        }

        drawCall.renderData = new Render.DrawCallRenderData(this.device, this.cache, rspState.textureCache, rspState.segmentBuffers, drawCall);
        this.drawCall = drawCall;
        this.textureCache = rspState.textureCache;
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, drawMatrix: mat4, frame: number, prim_color: Color | null = null): void {
        if (this.visible !== true) {
            return;
        }

        const template = renderInstManager.pushTemplateRenderInst();
        template.setBindingLayouts(Render.bindingLayouts);
        template.setMegaStateFlags(this.megaStateFlags);

        if (!this.isOrtho) {
            mat4.getTranslation(depthScratch, viewerInput.camera.worldMatrix);
            mat4.getTranslation(lookatScratch, drawMatrix);

            template.sortKey = setSortKeyDepth(this.sortKey, vec3.distance(depthScratch, lookatScratch));
        } else {
            template.sortKey = this.sortKey;
        }

        const sceneParamsSize = 16;

        let offs = template.allocateUniformBuffer(F3DEX_Program.ub_SceneParams, sceneParamsSize);
        const mappedF32 = template.mapUniformBufferF32(F3DEX_Program.ub_SceneParams);

        if (!this.isOrtho) {
            offs += fillMatrix4x4(mappedF32, offs, viewerInput.camera.projectionMatrix);
        } else {
            const aspect = viewerInput.backbufferWidth / viewerInput.backbufferHeight;
            mat4.ortho(projectionMatrixScratch, 0, 640, 640 / aspect, 0, -1, 1);
            offs += fillMatrix4x4(mappedF32, offs, projectionMatrixScratch);
        }

        this.drawCall.textureIndices[0] = this.frames[frame];
        if (prim_color !== null) {
            // TODO: this could accidentally latch prim colors across
            //       independent objects if one of them renders a sprite
            //       with prim color and the other does not. be careful
            //       here.
            this.drawCall.DP_PrimColor = prim_color;
        }

        const drawCallInstance = new Render.DrawCallInstance(this.drawCall, drawMatrix, this.textureCache);
        drawCallInstance.prepareToRender(device, renderInstManager, viewerInput, this.isOrtho, this.isBillboard);

        renderInstManager.popTemplateRenderInst();
    }

    public destroy(device: GfxDevice): void {
        this.drawCall.destroy(device);
    }
}


export class GloverSpriteRenderer extends GloverBaseSpriteRenderer {
    constructor(
        device: GfxDevice,
        cache: GfxRenderCache,
        textures: Textures.GloverTextureHolder,
        frameset: number[],
        xlu: boolean = false) {
        super(device, cache, textures, frameset, xlu);
        this.initialize();
    }

}

export class GloverBackdropRenderer extends GloverBaseSpriteRenderer {

    private drawMatrix = mat4.create();

    private backdropWidth: number = 0; 
    private backdropHeight: number = 0; 

    public sortKey: number;
    public textureId: number;

    protected isOrtho = true;
    protected isBillboard = false;

    constructor(
        device: GfxDevice,
        cache: GfxRenderCache,
        textures: Textures.GloverTextureHolder,
        protected backdropObject: GloverLevel.Backdrop,
        protected primitiveColor: number[])
    {
        super(device, cache, textures, [backdropObject.textureId]);

        this.initialize();

        this.sortKey = backdropObject.sortKey;
        this.textureId = backdropObject.textureId;
    }

    protected initialize() {
        this.loadFrameset(this.frameset);
        const rect = {
            sX: 0,
            sY: 0,
            sW: this.frame_textures[0].width * 2,
            sH: this.frame_textures[0].height,
            ulS: 0,
            ulT: 0,
            lrS: 0,
            lrT: 0
        };
        rect.ulS = rect.sW * 32;
        rect.ulT = rect.sH * 32;

        if (this.backdropObject.flipY != 0) {
            [rect.ulT, rect.lrT] = [rect.lrT, rect.ulT];
        } 

        rect.sW *= this.backdropObject.scaleX / 1024;
        rect.sH *= this.backdropObject.scaleY / 1024;
        this.buildDrawCall(rect, Render.G_TX_WRAP | Render.G_TX_NOMIRROR);

        this.backdropWidth = rect.sW;
        this.backdropHeight = rect.sH;
    }

    protected initializePipeline(rspState: Render.GloverRSPState) {
        Render.initializeRenderState(rspState);
        Render.setRenderMode(rspState, true, false, false, 1.0);

        rspState.gDPSetOtherModeH(0x14, 0x02, 0x0000); // gsDPSetCycleType(G_CYC_1CYCLE)
        rspState.gDPSetCombine(0xFC119623, 0xFF2FFFFF);
        rspState.gDPSetRenderMode(RDPRenderModes.G_RM_AA_XLU_SURF, RDPRenderModes.G_RM_AA_XLU_SURF2);
        rspState.gSPTexture(true, 0, 5, 0.999985 * 0x10000 / 32, 0.999985 * 0x10000 / 32);
        if (this.primitiveColor !== undefined) {
            rspState.gDPSetPrimColor(0, 0, this.primitiveColor[0], this.primitiveColor[1], this.primitiveColor[2], 0xFF);
        } else {
            rspState.gDPSetPrimColor(0, 0, 0xFF, 0xFF, 0xFF, 0xFF);
        }

    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        const view = viewerInput.camera.viewMatrix;
        const yaw = Math.atan2(-view[2], view[0]) / (Math.PI * 2);
        const pitch = Math.asin(view[6]) / (Math.PI * 2);

        mat4.fromTranslation(this.drawMatrix, [
            -(yaw + 0.5) * this.backdropObject.scrollSpeedX * this.backdropWidth / 2,
            Math.min(((-Math.sin(pitch*2*Math.PI)*500 + this.backdropObject.offsetY)/2) + (136/(this.backdropObject.scaleY/1024)), 0),
            0
        ]);

        super.prepareToRender(device, renderInstManager, viewerInput, this.drawMatrix, 0); 
    }
}

export class GloverFlipbookRenderer implements Shadows.ShadowCaster {
    private static renderCache: Map<string, GloverSpriteRenderer> = new Map<string, GloverSpriteRenderer>();
 
    private spriteRenderer: GloverSpriteRenderer;

    private frameDelay: number;
    private lastFrameAdvance: number = 0;
    private frameCounter: number = 0;
    public curFrame: number;
    
    public startSize: number;
    public endSize: number;
    public startAlpha: number;
    public endAlpha: number;

    private lifetime: number = -1;
    private timeRemaining: number = 0;

    public isGarib: boolean = false;

    public loop: boolean = true;
    public playing: boolean = true;

    public shadow: Shadows.Shadow | null = null;
    public shadowSize: number = 8;

    public visible: boolean = true;

    public drawMatrix: mat4 = mat4.create();

    private drawMatrixScratch: mat4 = mat4.create();

    private vec3Scratch: vec3 = vec3.create();

    private primColor: Color = {r: 1, g: 1, b: 1, a: 1};

    constructor(
        private device: GfxDevice,
        private cache: GfxRenderCache,
        private textures: Textures.GloverTextureHolder,
        private flipbookMetadata: Flipbook)
    {
        this.setSprite(flipbookMetadata);

    }

    public setLifetime(time: number) {
        this.lifetime = time;
        this.timeRemaining = time;
    }

    public getPosition(): vec3 {
        mat4.getTranslation(this.vec3Scratch, this.drawMatrix);
        return this.vec3Scratch;
    }

    public setPrimColor(r: number, g: number, b: number) {
        this.primColor.r = r / 255;
        this.primColor.g = g / 255;
        this.primColor.b = b / 255;
    }

    public setSprite(flipbookMetadata: Flipbook): void {
        this.flipbookMetadata = flipbookMetadata;

        this.startAlpha = this.flipbookMetadata.startAlpha;
        this.endAlpha = this.flipbookMetadata.endAlpha;
        this.startSize = this.flipbookMetadata.startSize;
        this.endSize = this.flipbookMetadata.endSize;

        let key = String(flipbookMetadata.frameset)
        if (GloverFlipbookRenderer.renderCache.has(key)) {
            this.spriteRenderer = GloverFlipbookRenderer.renderCache.get(key)!;
        } else {
            const xlu = (flipbookMetadata.startAlpha != flipbookMetadata.endAlpha) || (flipbookMetadata.flags & 0x10000) != 0;
            this.spriteRenderer = new GloverSpriteRenderer(this.device, this.cache, this.textures, flipbookMetadata.frameset, xlu);
            GloverFlipbookRenderer.renderCache.set(key, this.spriteRenderer);
        }        

        this.playing = true;

        if (flipbookMetadata.type === FlipbookType.RandomStartLooping) {
            this.curFrame = Math.floor(Math.random() * flipbookMetadata.frameset.length);
        } else {
            this.curFrame = 0;
        }
        this.frameDelay = flipbookMetadata.frameDelay;
        this.frameCounter = this.frameDelay;

        if (flipbookMetadata.type === FlipbookType.Oneshot) {
            this.loop = false;
        } else {
            this.loop = true;
        }
    }

    public reset() {
        this.playing = true;
        this.frameCounter = this.frameDelay;
        if (this.flipbookMetadata.type === FlipbookType.RandomStartLooping) {
            this.curFrame = Math.floor(Math.random() * this.flipbookMetadata.frameset.length);
        } else {
            this.curFrame = 0;
        }
        this.lifetime = -1;
        this.timeRemaining = 0;
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        if (this.flipbookMetadata.frameset.length > 1 && this.frameDelay >= 0) {
            this.lastFrameAdvance += viewerInput.deltaTime;
            if (this.lastFrameAdvance > 50) {
                this.lastFrameAdvance = 0;

                if (this.frameCounter > 0) {
                    this.frameCounter -= 0x20;
                } else {
                    this.frameCounter += this.frameDelay;
                    this.curFrame += 1;
                    if (this.curFrame >= this.flipbookMetadata.frameset.length) {
                        if (this.loop) {
                            this.curFrame = 0;
                            this.playing = true;
                        } else {
                            this.curFrame = this.flipbookMetadata.frameset.length - 1;
                            this.playing = false;
                        }
                    }
                }
            }
        }

        let alpha = 0xFF;
        if (this.startAlpha != this.endAlpha) {
            alpha = this.startAlpha;
            if (this.lifetime < 0) {
                const nFrames = this.flipbookMetadata.frameset.length;
                alpha += (this.endAlpha - this.startAlpha) * (nFrames - this.curFrame - 1) / (nFrames - 1);
            } else {
                alpha += (this.endAlpha - this.startAlpha) * this.timeRemaining / this.lifetime;
            }
        }
        this.primColor.a = alpha / 255;

        let size = this.startSize;
        if (this.startSize != this.endSize) {
            if (this.lifetime < 0) {
                const nFrames = this.flipbookMetadata.frameset.length;
                size += (this.endSize - this.startSize) * (nFrames - this.curFrame - 1) / (nFrames - 1);
            } else {
                size += (this.endSize - this.startSize) * this.timeRemaining / this.lifetime;
            }
        }
        size /= 3;

        if (this.lifetime > 0) {
            this.timeRemaining -= viewerInput.deltaTime;
            if (this.timeRemaining <= 0) {
                this.playing = false;
            }
        }

        if (this.visible) {
            mat4.scale(this.drawMatrixScratch, this.drawMatrix, [size, size, size]);
            this.spriteRenderer.prepareToRender(device, renderInstManager, viewerInput, this.drawMatrixScratch, this.curFrame, this.primColor);
        }
    }

    public destroy(device: GfxDevice): void {
        this.spriteRenderer.destroy(device);
        GloverFlipbookRenderer.renderCache.delete(this.spriteRenderer.cacheKey());
    }
}

export class GloverShadowRenderer extends GloverSpriteRenderer {
    protected isBillboard: boolean = false;

    public drawMatrix: mat4 = mat4.create();

    protected initializePipeline(rspState: Render.GloverRSPState) {
        Render.initializeRenderState(rspState);
        rspState.gSPSetGeometryMode(F3DEX.RSP_Geometry.G_ZBUFFER); // 0xB7000000 0x00000001
        rspState.gDPSetRenderMode(RDPRenderModes.G_RM_ZB_CLD_SURF, RDPRenderModes.G_RM_ZB_CLD_SURF2); // 0xb900031d 0x00504b50
        rspState.gDPSetCombine(0xfc119623, 0xff2fffff); // G_CC_MODULATEIA_PRIM, G_CC_MODULATEIA_PRIM
        rspState.gSPTexture(true, 0, 5, 0.999985 * 0x10000 / 32, 0.999985 * 0x10000 / 32);
        rspState.gDPSetPrimColor(0, 0, 0, 0, 0, 0xFF);
    }
    
    constructor(
        device: GfxDevice,
        cache: GfxRenderCache,
        textures: Textures.GloverTextureHolder)
    {
        super(device, cache, textures, [0x147b7297]);
        this.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT + Render.GloverRendererLayer.FOOTPRINTS);
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        super.prepareToRender(device, renderInstManager, viewerInput, this.drawMatrix, 0);
    }
}

export enum WeatherType {
    Rain,
    Snow
}


export class GloverUISpriteRenderer extends GloverBaseSpriteRenderer {
    protected isOrtho = true;
    protected isBillboard = false;
    protected primColor: Color = {r: 1, g: 1, b: 1, a: 1};

    constructor(
        device: GfxDevice,
        cache: GfxRenderCache,
        textures: Textures.GloverTextureHolder,
        protected textureId: number)
    {
        super(device, cache, textures, [textureId]);
        this.sortKey = makeSortKey(GfxRendererLayer.TRANSLUCENT + Render.GloverRendererLayer.WEATHER);
        this.initialize();
    }

    protected initialize() {
        this.loadFrameset(this.frameset);
        let tex = this.frame_textures[0];
        const rect = {
            sW: tex.width,
            sH: tex.height,
            sX: -tex.width/2,
            sY: -tex.height/2,
            ulS: 0,
            ulT: 0,
            lrS: tex.width * 32,
            lrT: tex.height * 32
        };
        this.buildDrawCall(rect);
    }

    protected initializePipeline(rspState: Render.GloverRSPState) {
        Render.initializeRenderState(rspState);
        Render.setRenderMode(rspState, true, false, false, 1.0);

        rspState.gDPSetOtherModeH(0x14, 0x02, 0x0000); // gsDPSetCycleType(G_CYC_1CYCLE)
        rspState.gDPSetCombine(0xFC119623, 0xFF2FFFFF);
        rspState.gDPSetRenderMode(RDPRenderModes.G_RM_AA_XLU_SURF, RDPRenderModes.G_RM_AA_XLU_SURF2);
        
        // TODO: should be .5 rather than .99?
        rspState.gSPTexture(true, 0, 5, 0.999985 * 0x10000 / 32, 0.999985 * 0x10000 / 32);
        rspState.gDPSetPrimColor(0, 0, 0xFF, 0xFF, 0xFF, 0xFF);
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput, drawMatrix: mat4, alpha: number): void {
        this.primColor.a = alpha / 0xFF;
        super.prepareToRender(device, renderInstManager, viewerInput, drawMatrix, 0, this.primColor);
    }
}

export interface WeatherParams {
    type: WeatherType;
    iterations_per_frame: number;
    particles_per_iteration: number;
    lifetime: number;
    alphas: [number, number, number];
    velocity: [number, number];
    particle_lifetime_min: number;
};

class Debris {
    public active: boolean = false;
    public pos: [number, number] = [0, 0];
    public vel: [number, number] = [0, 0];
    public scale: [number, number] = [1, 1];
    public curAlpha: number = 0xFF;
    public targetAlpha: number = 0xFF;
    public curParallaxEffect: number = 1;
    public targetParallaxEffect: number = 1;
    public lifetimeCounter: number = 0;
    public countdownToFadeout: number = 0;
}

export class GloverWeatherRenderer {
    private spriteRenderer: GloverUISpriteRenderer;
    
    public visible: boolean = true;

    private drawMatrixScratch: mat4 = mat4.create();
    private vec3Scratch: vec3 = vec3.create();

    private debris: Debris[] = [];

    private curIterCount: number = 0;
    private curParticleCycle: number = 0;

    private lastFrameAdvance: number = 0;

    private lastYaw: number = 0;
    private lastCamPos: vec3 = vec3.create();

    constructor(
        private device: GfxDevice,
        private cache: GfxRenderCache,
        private textures: Textures.GloverTextureHolder,
        private params: WeatherParams)
    {
        this.spriteRenderer = new GloverUISpriteRenderer(
            this.device, this.cache, this.textures,
            (params.type === WeatherType.Rain) ? 0xCB588DD9 : 0x1AF9F784; // raindrop.bmp / ai_snow.bmp
        );
        for (let x=0; x<40; x++) {
            this.debris.push(new Debris());
        }
    }

    private generateWeatherParticles(viewerInput: Viewer.ViewerRenderInput) {
        for (this.curIterCount += this.params.iterations_per_frame; this.curIterCount > 0x40; this.curIterCount -= 0x40) {
            for (let particleCount = 0; particleCount < this.params.particles_per_iteration; particleCount += 1) {
                let found = false;
                for (let singleDebris of this.debris) {
                    if (singleDebris.active) {
                        continue;
                    }
                    found = true;
                    
                    singleDebris.active = true;
                    singleDebris.pos = [Math.floor(Math.random()*viewerInput.backbufferWidth*4), 0];
                    singleDebris.vel = [this.params.velocity[0], this.params.velocity[1]];
                    singleDebris.countdownToFadeout = 0xf;
                    if (this.curParticleCycle == 0) {
                        singleDebris.curParallaxEffect = 0x400;
                    } else if (this.curParticleCycle == 1) {
                        singleDebris.curParallaxEffect = 0x300;
                        singleDebris.vel[0] *= 0.75;
                        singleDebris.vel[1] *= 0.75;
                    } else {
                        singleDebris.curParallaxEffect = 0x200;
                        singleDebris.vel[0] *= 0.5;
                        singleDebris.vel[1] *= 0.5;
                    }
                    singleDebris.scale = [singleDebris.curParallaxEffect, singleDebris.curParallaxEffect];
                    singleDebris.targetParallaxEffect = singleDebris.curParallaxEffect;
                    singleDebris.curAlpha = this.params.alphas[this.curParticleCycle];
                    singleDebris.targetAlpha = singleDebris.curAlpha;
                    singleDebris.lifetimeCounter = this.params.particle_lifetime_min + Math.floor(Math.random()*2);

                    this.curParticleCycle = (this.curParticleCycle < 3) ? this.curParticleCycle + 1 : 0;
                }
                if (!found) {
                    let tmp = this.curIterCount;
                    if (tmp < 0) {
                        tmp += 0x3f;
                    }
                    this.curIterCount -= ((tmp & 0xFFFF)>>6)*-0x40;
                    return;
                }
            }            
        }

    }

    private advanceActiveParticles(viewerInput: Viewer.ViewerRenderInput) {
        // Advance state
        const view = viewerInput.camera.viewMatrix;
        const yaw = Math.atan2(-view[2], view[0]) / (Math.PI * 2);
        const camPosition = lookatScratch;
        mat4.getTranslation(lookatScratch, view);

        const scaleFactor = 1200;

        let camVelocity = [camPosition[0]-this.lastCamPos[0], camPosition[2]-this.lastCamPos[2]];

        for (let singleDebris of this.debris) {
            if (!singleDebris.active) {
                continue;
            }

            // [1,0] rotated by camera yaw:
            let tmp_vec = [ 
                Math.cos(-yaw),
                Math.sin(-yaw)
            ]

            singleDebris.pos[0] -= (tmp_vec[0] * camVelocity[0] + tmp_vec[1] * camVelocity[1]) * Math.pow(singleDebris.curParallaxEffect, 2) / 2000000;

            let angleDiff = subtractAngles(this.lastYaw, yaw);
            singleDebris.pos[0] += angleDiff * Math.pow(singleDebris.curParallaxEffect,2) / -3000;

            if (singleDebris.pos[0] > viewerInput.backbufferWidth - 40) {
                singleDebris.pos[0] -= viewerInput.backbufferWidth;
            } else if (singleDebris.pos[0] < -40) {
                singleDebris.pos[0] += viewerInput.backbufferWidth;
            }

            if (this.params.type === WeatherType.Snow) {
                // TODO: rain looks fine but snow looks way off
                const drift = Math.sin(singleDebris.lifetimeCounter/10);
                singleDebris.vel[0] = drift * singleDebris.curParallaxEffect / 256;
 
                tmp_vec = [-tmp_vec[1], -tmp_vec[0]];

                singleDebris.targetParallaxEffect += (tmp_vec[0] * camVelocity[0] + tmp_vec[1] * camVelocity[1]) * -3;
                if (singleDebris.targetParallaxEffect > scaleFactor || singleDebris.targetParallaxEffect < 100) {
                    singleDebris.targetParallaxEffect = scaleFactor;
                }

                singleDebris.curParallaxEffect = singleDebris.targetParallaxEffect;

                const a = Math.floor(this.params.alphas[2]/2);
                singleDebris.targetAlpha = a + (0xff - a) * singleDebris.curParallaxEffect / scaleFactor;
                singleDebris.curAlpha = singleDebris.targetAlpha;

                singleDebris.vel[1] = this.params.velocity[1] * (0.25 + singleDebris.curParallaxEffect / scaleFactor);
            }

            singleDebris.pos[0] -= singleDebris.vel[0]/4;
            singleDebris.pos[1] += singleDebris.vel[1]/4;
            singleDebris.lifetimeCounter -= 1;

            if (singleDebris.lifetimeCounter == 0 || singleDebris.pos[1] > viewerInput.backbufferHeight * 4) {
                singleDebris.active = false;
            }
        }

        this.lastYaw = yaw;
        vec3.copy(this.lastCamPos, camPosition);
    }

    public prepareToRender(device: GfxDevice, renderInstManager: GfxRenderInstManager, viewerInput: Viewer.ViewerRenderInput): void {
        if (!this.visible) {
            return;
        }

        // const scaleFactor = (1024*480)/viewerInput.backbufferHeight;
        const scaleFactor = 1024;

        this.lastFrameAdvance += viewerInput.deltaTime;
        if(this.lastFrameAdvance >= SRC_FRAME_TO_MS) {
            this.advanceActiveParticles(viewerInput);
            this.generateWeatherParticles(viewerInput);
            this.lastFrameAdvance = 0;
        }

        for (let singleDebris of this.debris) {
            if (!singleDebris.active) {
                continue;
            }
            mat4.fromTranslation(this.drawMatrixScratch,
                [singleDebris.pos[0]/4, singleDebris.pos[1]/4, 0]);
            mat4.scale(this.drawMatrixScratch, this.drawMatrixScratch,
                [singleDebris.scale[0]*4/scaleFactor, -singleDebris.scale[1]*4/scaleFactor, 1]);
            this.spriteRenderer.prepareToRender(device, renderInstManager, viewerInput, this.drawMatrixScratch, singleDebris.curAlpha);
        }

    }

    public destroy(device: GfxDevice): void {
        this.spriteRenderer.destroy(device);
    }
}
