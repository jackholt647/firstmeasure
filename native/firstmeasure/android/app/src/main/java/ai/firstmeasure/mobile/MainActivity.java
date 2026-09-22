package ai.firstmeasure.mobile;

import android.app.AlertDialog;
import android.content.*;
import android.net.Uri;
import android.os.Bundle;
import android.provider.MediaStore;
import android.provider.Settings;
import android.view.*;
import android.webkit.*;
import android.widget.*;
import androidx.activity.ComponentActivity;
import androidx.activity.OnBackPressedCallback;
import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;
import androidx.core.content.FileProvider;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.webkit.*;
import org.json.JSONObject;
import java.io.*;
import java.net.URL;
import java.net.HttpURLConnection;
import java.util.*;
import java.util.concurrent.*;

public class MainActivity extends ComponentActivity {
    private WebView web;
    private LinearLayout root;
    private final OriginPolicy policy = new OriginPolicy(BuildConfig.PORTAL_ORIGIN);
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private ValueCallback<Uri[]> fileCallback;
    private Uri cameraUri;
    private PermissionRequest audioRequest;
    private final ActivityResultLauncher<String> microphone = registerForActivityResult(new ActivityResultContracts.RequestPermission(), granted -> {
        PermissionRequest request=audioRequest;audioRequest=null;
        if(request==null)return;
        if(granted && policy.trusted(request.getOrigin().toString()) && policy.trusted(web.getUrl()))request.grant(new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE});else request.deny();
    });
    private final Set<String> inflight = new HashSet<>();
    private String authVerifier,authState;
    private final ActivityResultLauncher<Intent> picker = registerForActivityResult(new ActivityResultContracts.StartActivityForResult(), result -> {
        Uri[] files = null;
        if (result.getResultCode() == RESULT_OK) {
            Intent data = result.getData();
            if (data != null && data.getClipData() != null) {
                ClipData clips=data.getClipData(); files=new Uri[clips.getItemCount()];
                for(int i=0;i<files.length;i++) files[i]=clips.getItemAt(i).getUri();
            } else if (data != null && data.getData() != null) files=new Uri[]{data.getData()};
            else if (cameraUri != null) files=new Uri[]{cameraUri};
        }
        completePicker(files);
    });

    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        android.content.SharedPreferences auth=getPreferences(MODE_PRIVATE);
        if(auth.getLong("auth_expires",0)>System.currentTimeMillis()){authState=auth.getString("auth_state",null);authVerifier=auth.getString("auth_verifier",null);}
        root=new LinearLayout(this); root.setOrientation(LinearLayout.VERTICAL); setContentView(root);
        ViewCompat.setOnApplyWindowInsetsListener(root, (view,insets)->{
            androidx.core.graphics.Insets i=insets.getInsets(WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.ime());
            view.setPadding(i.left,i.top,i.right,i.bottom); return insets;
        });
        web=new WebView(this); web.setId(View.generateViewId()); root.addView(web,new LinearLayout.LayoutParams(-1,0,1));
        WebSettings settings=web.getSettings(); settings.setJavaScriptEnabled(true); settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false); settings.setAllowContentAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setSupportMultipleWindows(true); settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setUserAgentString(settings.getUserAgentString()+" FirstMeasureMobile/"+BuildConfig.VERSION_NAME);
        CookieManager.getInstance().setAcceptCookie(true); CookieManager.getInstance().setAcceptThirdPartyCookies(web,false);
        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            showError("Please update Android System WebView to use FirstMeasure."); return;
        }
        WebViewCompat.addWebMessageListener(web,"FirstMeasureNative",Set.of(BuildConfig.PORTAL_ORIGIN), (view,message,source,isMain,reply)->{
            if (!isMain || !policy.trusted(source.toString()) || !policy.trusted(view.getUrl())) return;
            handle(message.getData(),reply);
        });
        web.setWebViewClient(new WebViewClient(){
            @Override public boolean shouldOverrideUrlLoading(WebView view,WebResourceRequest request){
                if(!request.isForMainFrame()) return !"https".equals(request.getUrl().getScheme());
                return navigate(request.getUrl().toString());
            }
            @Override public void onPageFinished(WebView view,String url){ CookieManager.getInstance().flush(); }
            @Override public void onReceivedError(WebView view,WebResourceRequest request,WebResourceError error){
                if(request.isForMainFrame()) showError("Unable to connect. Check your connection and try again.");
            }
            @Override public void onReceivedHttpError(WebView view,WebResourceRequest request,WebResourceResponse response){
                if(request.isForMainFrame() && response.getStatusCode()>=500) showError("FirstMeasure is temporarily unavailable. Please try again.");
            }
        });
        web.setWebChromeClient(new WebChromeClient(){
            @Override public boolean onShowFileChooser(WebView view,ValueCallback<Uri[]> callback,FileChooserParams params){
                if(!policy.trusted(view.getUrl())) { callback.onReceiveValue(null); return true; }
                completePicker(null); fileCallback=callback;
                String[] accepts=Arrays.stream(params.getAcceptTypes()).filter(s->s!=null&&!s.isBlank()).toArray(String[]::new);
                Intent files=new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType(accepts.length==1?accepts[0]:"*/*");
                if(accepts.length>1) files.putExtra(Intent.EXTRA_MIME_TYPES,accepts);
                files.putExtra(Intent.EXTRA_ALLOW_MULTIPLE,params.getMode()==FileChooserParams.MODE_OPEN_MULTIPLE);
                boolean images=accepts.length==0 || Arrays.stream(accepts).anyMatch(s->s.startsWith("image/") || s.equals("*/*"));
                Intent camera=images?cameraIntent():null;
                try {
                    if(params.isCaptureEnabled() && camera!=null) picker.launch(camera);
                    else { Intent chooser=Intent.createChooser(files,"Choose files"); if(camera!=null) chooser.putExtra(Intent.EXTRA_INITIAL_INTENTS,new Intent[]{camera}); picker.launch(chooser); }
                } catch(Exception e){ completePicker(null); showMessage("No compatible camera or file picker is available."); }
                return true;
            }
            @Override public boolean onCreateWindow(WebView view,boolean dialog,boolean gesture,android.os.Message message){
                if(!gesture)return false;
                WebView popup=new WebView(MainActivity.this);
                popup.setWebViewClient(new WebViewClient(){ @Override public boolean shouldOverrideUrlLoading(WebView v,WebResourceRequest r){
                    String url=r.getUrl().toString(); if(policy.trusted(url))web.loadUrl(url);else external(url); v.destroy();return true;
                }});
                ((WebView.WebViewTransport)message.obj).setWebView(popup);message.sendToTarget();return true;
            }
            @Override public void onPermissionRequest(PermissionRequest request){
                if(!policy.trusted(request.getOrigin().toString()) || !policy.trusted(web.getUrl()) || audioRequest!=null || !Arrays.equals(request.getResources(),new String[]{PermissionRequest.RESOURCE_AUDIO_CAPTURE})){request.deny();return;}
                audioRequest=request;microphone.launch(android.Manifest.permission.RECORD_AUDIO);
            }
            @Override public void onPermissionRequestCanceled(PermissionRequest request){if(audioRequest==request)audioRequest=null;}
        });
        web.setDownloadListener((url,ua,disposition,mime,length)->{
            if(policy.trusted(url)) download(url,null,null); else showMessage("Open this download in your browser.");
        });
        getOnBackPressedDispatcher().addCallback(this,new OnBackPressedCallback(true){
            @Override public void handleOnBackPressed(){if(web.canGoBack())web.goBack();else finish();}
        });
        if(saved==null || web.restoreState(saved)==null) web.loadUrl(BuildConfig.PORTAL_ORIGIN+"/portal/");
        acceptAuthReturn(getIntent());
        pruneFiles();
    }
    private boolean navigate(String url){ if(policy.trusted(url))return false;external(url);return true; }
    private void external(String url){
        if(!OriginPolicy.external(url))return;
        try{startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(url)));}catch(Exception e){showMessage("No app is available to open this link.");}
    }
    private Intent cameraIntent(){
        Intent intent=new Intent(MediaStore.ACTION_IMAGE_CAPTURE);
        if(intent.resolveActivity(getPackageManager())==null)return null;
        try {
            File file=File.createTempFile("photo-",".jpg",phoneDirectory());
            cameraUri=FileProvider.getUriForFile(this,BuildConfig.APPLICATION_ID+".files",file);
            intent.putExtra(MediaStore.EXTRA_OUTPUT,cameraUri).addFlags(Intent.FLAG_GRANT_WRITE_URI_PERMISSION|Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri("photo",cameraUri)); return intent;
        } catch(IOException e){return null;}
    }
    private void completePicker(Uri[] files){ if(fileCallback!=null){fileCallback.onReceiveValue(files);fileCallback=null;} cameraUri=null; }
    private void handle(String raw,JavaScriptReplyProxy reply){
        String id="";
        try {
            if(raw==null||raw.length()>23*1024*1024)throw new Exception("Invalid request");
            JSONObject call=new JSONObject(raw);id=call.getString("id");
            if(id.length()>64||call.getInt("version")!=1)throw new Exception("Unsupported bridge version");
            JSONObject payload=call.optJSONObject("payload");if(payload==null)payload=new JSONObject();
            if(raw.length()>32768&&!call.getString("method").equals("saveFile"))throw new Exception("Request too large");
            switch(call.getString("method")){
                case "authenticate":
                    authVerifier=nonce();authState=nonce();
                    getPreferences(MODE_PRIVATE).edit().putString("auth_state",authState).putString("auth_verifier",authVerifier).putLong("auth_expires",System.currentTimeMillis()+600000).apply();
                    String challenge=android.util.Base64.encodeToString(java.security.MessageDigest.getInstance("SHA-256").digest(authVerifier.getBytes(java.nio.charset.StandardCharsets.UTF_8)),android.util.Base64.URL_SAFE|android.util.Base64.NO_WRAP|android.util.Base64.NO_PADDING);
                    startActivity(new Intent(Intent.ACTION_VIEW,Uri.parse(BuildConfig.PORTAL_ORIGIN+"/v1/mobile/auth/browser?challenge="+challenge+"&state="+authState)));respond(reply,id,true,null);break;
                case "info": respond(reply,id,new JSONObject().put("bridgeVersion",1).put("platform","android").put("version",BuildConfig.VERSION_NAME).put("environment",BuildConfig.FLAVOR).put("capabilities",new org.json.JSONArray(List.of("files","camera","share","download","haptic","settings"))),null);break;
                case "haptic": web.performHapticFeedback(HapticFeedbackConstants.CONTEXT_CLICK);respond(reply,id,true,null);break;
                case "settings":startActivity(new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,Uri.parse("package:"+getPackageName())));respond(reply,id,true,null);break;
                case "share":
                    String url=payload.optString("url");if(!url.isEmpty()&&!url.startsWith("https://"))throw new Exception("Unsupported share link");
                    String text=payload.optString("text")+(url.isEmpty()?"":"\n"+url);
                    startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType("text/plain").putExtra(Intent.EXTRA_TEXT,text).putExtra(Intent.EXTRA_SUBJECT,payload.optString("title")),"Share"));respond(reply,id,true,null);break;
                case "download":download(payload.getString("url"),id,reply);break;
                case "saveFile":
                    byte[] bytes=android.util.Base64.decode(payload.getString("data"),android.util.Base64.DEFAULT);
                    if(bytes.length>16*1024*1024)throw new Exception("File too large");
                    String name=payload.optString("name","download").replaceAll("[^a-zA-Z0-9._-]","_");if(name.length()>120)name=name.substring(name.length()-120);
                    File export=new File(phoneDirectory(),UUID.randomUUID()+"-"+name);
                    try(OutputStream output=new FileOutputStream(export)){output.write(bytes);}
                    Uri exported=FileProvider.getUriForFile(this,BuildConfig.APPLICATION_ID+".files",export);
                    startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType(payload.optString("mime","application/octet-stream")).putExtra(Intent.EXTRA_STREAM,exported).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),"Save or share"));respond(reply,id,true,null);break;
                default:respond(reply,id,null,"unsupported");
            }
        }catch(Exception e){respond(reply,id,null,"invalid_request");}
    }
    private void respond(JavaScriptReplyProxy reply,String id,Object value,String error){
        if(reply==null)return;
        try{JSONObject result=new JSONObject().put("id",id);if(error!=null)result.put("error",new JSONObject().put("code",error).put("message","The phone action could not be completed."));else result.put("result",value);reply.postMessage(result.toString());}catch(Exception ignored){}
    }
    private void download(String url,String id,JavaScriptReplyProxy reply){
        if(!policy.trusted(url)){respond(reply,id,null,"untrusted_url");return;}
        if(!inflight.add(url)){respond(reply,id,null,"download_in_progress");return;}
        String cookies=CookieManager.getInstance().getCookie(url);
        io.execute(()->{
            File file=null;
            try {
                URL current=new URL(url);HttpURLConnection connection=null;
                for(int redirects=0;redirects<6;redirects++){
                    if(!policy.trusted(current.toString()))throw new IOException("Untrusted redirect");
                    connection=(HttpURLConnection)current.openConnection();connection.setInstanceFollowRedirects(false);connection.setConnectTimeout(15000);connection.setReadTimeout(30000);
                    if(cookies!=null)connection.setRequestProperty("Cookie",cookies);
                    int code=connection.getResponseCode();
                    if(code>=300&&code<400){String location=connection.getHeaderField("Location");connection.disconnect();if(location==null)throw new IOException("Missing location");current=new URL(current,location);continue;}
                    if(code!=200)throw new IOException("Download unavailable");break;
                }
                if(connection==null||connection.getResponseCode()!=200)throw new IOException("Too many redirects");
                String mime=connection.getContentType();if(mime==null||mime.startsWith("text/html"))throw new IOException("Please sign in again");
                String name=URLUtil.guessFileName(current.toString(),connection.getHeaderField("Content-Disposition"),mime).replaceAll("[^a-zA-Z0-9._-]","_");
                file=new File(phoneDirectory(),UUID.randomUUID()+"-"+name);
                try(InputStream input=connection.getInputStream();OutputStream output=new FileOutputStream(file)){
                    byte[] buffer=new byte[65536];long size=0;int count;
                    while((count=input.read(buffer))!=-1){size+=count;if(size>150L*1024*1024)throw new IOException("Download too large");output.write(buffer,0,count);}
                }finally{connection.disconnect();}
                File completed=file;String type=mime.split(";")[0];
                runOnUiThread(()->{inflight.remove(url);if(isFinishing())return;Uri uri=FileProvider.getUriForFile(this,BuildConfig.APPLICATION_ID+".files",completed);
                    startActivity(Intent.createChooser(new Intent(Intent.ACTION_SEND).setType(type).putExtra(Intent.EXTRA_STREAM,uri).addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION),"Save or share"));respond(reply,id,true,null);});
            }catch(Exception e){if(file!=null)file.delete();runOnUiThread(()->{inflight.remove(url);respond(reply,id,null,"download_failed");showMessage("Download failed. Check your connection and sign-in, then try again.");});}
        });
    }
    private File phoneDirectory(){File directory=new File(getCacheDir(),"phone");directory.mkdirs();return directory;}
    private String nonce(){byte[] bytes=new byte[32];new java.security.SecureRandom().nextBytes(bytes);return android.util.Base64.encodeToString(bytes,android.util.Base64.URL_SAFE|android.util.Base64.NO_WRAP|android.util.Base64.NO_PADDING);}
    @Override protected void onNewIntent(Intent intent){
        super.onNewIntent(intent);acceptAuthReturn(intent);
    }
    private void acceptAuthReturn(Intent intent){
        Uri url=intent.getData();
        if(url==null||!BuildConfig.APPLICATION_ID.equals(url.getScheme())||!"auth".equals(url.getHost())||authState==null||!authState.equals(url.getQueryParameter("state")))return;
        String code=url.getQueryParameter("code");if(code==null||!code.matches("[A-Za-z0-9_-]{43}"))return;
        String body="code="+code+"&verifier="+authVerifier;authState=null;authVerifier=null;
        getPreferences(MODE_PRIVATE).edit().remove("auth_state").remove("auth_verifier").remove("auth_expires").apply();
        web.postUrl(BuildConfig.PORTAL_ORIGIN+"/v1/mobile/auth/exchange",body.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
    private void pruneFiles(){File[] files=phoneDirectory().listFiles();if(files!=null)for(File file:files)if(file.lastModified()<System.currentTimeMillis()-86400000L)file.delete();}
    private void showError(String message){
        if(isFinishing())return;
        new AlertDialog.Builder(this).setTitle("FirstMeasure").setMessage(message).setPositiveButton("Try again",(d,w)->web.loadUrl(BuildConfig.PORTAL_ORIGIN+"/portal/")).setNegativeButton("Close",(d,w)->finish()).show();
    }
    private void showMessage(String message){if(!isFinishing())Toast.makeText(this,message,Toast.LENGTH_LONG).show();}
    @Override protected void onSaveInstanceState(Bundle out){super.onSaveInstanceState(out);web.saveState(out);}
    @Override protected void onPause(){super.onPause();if(web!=null)web.onPause();CookieManager.getInstance().flush();}
    @Override protected void onResume(){super.onResume();if(web!=null)web.onResume();}
    @Override protected void onDestroy(){completePicker(null);if(web!=null){web.stopLoading();web.destroy();}io.shutdownNow();super.onDestroy();}
}
