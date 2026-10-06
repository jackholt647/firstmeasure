package ai.firstmeasure.mobile;

import java.util.List;

/** Zoom is relative to the default camera, not to whichever lens is active. */
final class CameraZoomRange {
    final double intrinsic,min,max,localMin,localMax;
    CameraZoomRange(double intrinsic,double localMin,double localMax){
        this.intrinsic=Double.isFinite(intrinsic)&&intrinsic>0?intrinsic:1;
        this.localMin=localMin;this.localMax=localMax;
        min=this.intrinsic*localMin;max=this.intrinsic*localMax;
    }
    double local(double zoom){return Math.max(localMin,Math.min(localMax,zoom/intrinsic));}
    static int select(List<CameraZoomRange> cameras,double zoom){
        int best=0;double score=Double.POSITIVE_INFINITY;
        for(int i=0;i<cameras.size();i++){
            CameraZoomRange c=cameras.get(i);
            // Prefer a range that contains the request, then the least digital
            // crop. A logical camera that zooms out wins over an extra rebind.
            double error=Math.abs(Math.log((c.local(zoom)*c.intrinsic)/zoom));
            double candidate=error*1000+Math.max(0,Math.log(c.local(zoom)));
            if(candidate<score){score=candidate;best=i;}
        }
        return best;
    }
}
