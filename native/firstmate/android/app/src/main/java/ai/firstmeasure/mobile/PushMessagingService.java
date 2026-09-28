package ai.firstmeasure.mobile;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

public final class PushMessagingService extends FirebaseMessagingService {
    private static final String[] CATEGORIES = {"leads","messages","mentions","tasks","scheduling","payments","celebrations","measurements","system"};
    private static final String[] LABELS = {"Leads","Messages","Mentions","Tasks","Scheduling","Payments","Celebrations","Measurements","System"};

    static void createChannels(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager=context.getSystemService(NotificationManager.class);
        if(manager==null)return;
        for(int i=0;i<CATEGORIES.length;i++){
            NotificationChannel channel=new NotificationChannel("firstmate_"+CATEGORIES[i],LABELS[i],CATEGORIES[i].equals("celebrations")?NotificationManager.IMPORTANCE_LOW:NotificationManager.IMPORTANCE_DEFAULT);
            channel.setDescription("FirstMate "+LABELS[i].toLowerCase()+" updates");
            manager.createNotificationChannel(channel);
        }
    }
    private static String category(String value){
        for(String known:CATEGORIES)if(known.equals(value))return known;
        return "system";
    }
    @Override public void onMessageReceived(RemoteMessage message){
        // FCM displays background notification payloads; foreground messages arrive here.
        createChannels(this);
        Map<String,String> data=message.getData();
        RemoteMessage.Notification notification=message.getNotification();
        if(notification==null || !NotificationManagerCompat.from(this).areNotificationsEnabled())return;
        String id=data.get("notification_id");
        Intent intent=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP|Intent.FLAG_ACTIVITY_SINGLE_TOP);
        if(id!=null)intent.putExtra("notification_id",id);
        int requestCode=id==null?message.getMessageId().hashCode():id.hashCode();
        PendingIntent tap=PendingIntent.getActivity(this,requestCode,intent,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);
        NotificationCompat.Builder builder=new NotificationCompat.Builder(this,"firstmate_"+category(data.get("category")))
            .setSmallIcon(R.drawable.app_icon).setContentTitle(notification.getTitle()).setContentText(notification.getBody())
            .setAutoCancel(true).setContentIntent(tap).setPriority(NotificationCompat.PRIORITY_DEFAULT);
        NotificationManagerCompat.from(this).notify(requestCode,builder.build());
    }
}
