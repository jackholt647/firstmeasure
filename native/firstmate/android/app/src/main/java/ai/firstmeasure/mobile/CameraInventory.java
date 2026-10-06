package ai.firstmeasure.mobile;

import java.util.*;

/** Hardware inventory, including children absent from CameraManager.getCameraIdList(). */
final class CameraInventory {
    interface Source { List<String> ids() throws Exception; Device read(String id) throws Exception; }
    static final class Device {
        final String id; final int facing; final List<String> children;
        final double focalScale,minZoom,maxZoom; final boolean colorCamera;
        Device(String id,int facing,List<String> children,double focalScale,double minZoom,double maxZoom,boolean colorCamera){
            this.id=id;this.facing=facing;this.children=children;this.focalScale=focalScale;this.minZoom=minZoom;this.maxZoom=maxZoom;this.colorCamera=colorCamera;
        }
    }
    static final class Route {
        final String logicalId,physicalId; final CameraZoomRange range;
        Route(String logicalId,String physicalId,CameraZoomRange range){this.logicalId=logicalId;this.physicalId=physicalId;this.range=range;}
        String key(){return logicalId+(physicalId==null?"": "/"+physicalId);}
    }
    final List<Route> routes=new ArrayList<>();
    final Map<String,String> failures=new LinkedHashMap<>();
    final Map<String,String> exclusions=new LinkedHashMap<>();
    static boolean supportsPreview(boolean backwardCompatible,int privateSizes,int yuvSizes){return backwardCompatible||privateSizes>0||yuvSizes>0;}
    static CameraInventory discover(Source source,int facing,String defaultId) throws Exception {
        CameraInventory result=new CameraInventory();
        Device standard=source.read(defaultId);
        for(String id:source.ids()){
            Device logical;
            try{logical=source.read(id);}catch(Exception e){result.failures.put(id,"characteristics_unavailable");continue;}
            if(logical.facing!=facing){result.exclusions.put(id,"different_facing");continue;}
            if(logical.colorCamera)add(result,logical,null,logical,standard);
            else result.exclusions.put(id,"no_advertised_preview_output");
            // Physical children need not be independently openable or have video profiles.
            for(String child:logical.children){
                if(child.equals(id))continue;
                try{
                    Device physical=source.read(child);
                    if(physical.facing!=facing)result.exclusions.put(id+"/"+child,"different_facing");
                    else if(!physical.colorCamera)result.exclusions.put(id+"/"+child,"no_advertised_preview_output");
                    else add(result,logical,child,physical,standard);
                }catch(Exception e){result.failures.put(id+"/"+child,"physical_characteristics_unavailable");}
            }
        }
        return result;
    }
    private static void add(CameraInventory result,Device logical,String physicalId,Device device,Device standard){
        double intrinsic=device.id.equals(standard.id)?1:device.focalScale/standard.focalScale;
        if(!Double.isFinite(intrinsic)||intrinsic<=0){result.failures.put(logical.id+"/"+device.id,"focal_geometry_unavailable");return;}
        // A pinned physical stream starts at the lens's uncropped field of view.
        double min=physicalId==null?device.minZoom:1;
        double max=physicalId==null?device.maxZoom:Math.min(device.maxZoom,logical.maxZoom);
        if(max<min||!Double.isFinite(max)){result.failures.put(logical.id+"/"+device.id,"zoom_range_unavailable");return;}
        result.routes.add(new Route(logical.id,physicalId,new CameraZoomRange(intrinsic,min,max)));
    }
}
